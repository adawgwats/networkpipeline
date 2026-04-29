import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { McpInvocationsRepository } from "@networkpipeline/db";

/**
 * MCPInvocation is one row's worth of observability per tool call.
 * Will be persisted to the `mcp_invocations` SQL table once issue #3
 * lands. Until then, we append JSONL to disk so we can iterate on what
 * to capture without paying for a schema migration on every change.
 */
export type MCPInvocation = {
  id: string;
  tool_name: string;
  args_hash: string;
  result_kind: "ok" | "validation_error" | "handler_error" | "unknown_tool";
  result_summary: string;
  started_at: string;
  latency_ms: number;
  /**
   * Optional opaque metadata (provider runs, criteria version, etc.).
   * Anything stored here is best-effort and may be reshaped by the
   * eventual SQL migration.
   */
  meta?: Record<string, unknown>;
};

export type ObservabilitySink = {
  record(invocation: MCPInvocation): void;
};

/**
 * NoopSink: drops every record. Useful in tests that don't care about
 * observability surface.
 */
export class NoopSink implements ObservabilitySink {
  record(_: MCPInvocation): void {
    // intentionally empty
  }
}

/**
 * InMemorySink: keeps invocations in an array for assertion in tests.
 * NEVER use in production — unbounded.
 */
export class InMemorySink implements ObservabilitySink {
  public readonly invocations: MCPInvocation[] = [];
  record(inv: MCPInvocation): void {
    this.invocations.push(inv);
  }
}

/**
 * SqliteSink: persists invocations into the `mcp_invocations` table via
 * @networkpipeline/db. This is the V1 production sink — replaces the
 * earlier JSONL-as-system-of-record arrangement now that schema work
 * in #3 has landed.
 *
 * The `meta` field on MCPInvocation is JSON-encoded to TEXT for
 * portability with the schema's `meta_json` column.
 */
export class SqliteSink implements ObservabilitySink {
  constructor(private readonly repo: McpInvocationsRepository) {}

  record(inv: MCPInvocation): void {
    this.repo.insert({
      id: inv.id,
      tool_name: inv.tool_name,
      args_hash: inv.args_hash,
      result_kind: inv.result_kind,
      result_summary: inv.result_summary,
      started_at: inv.started_at,
      latency_ms: inv.latency_ms,
      meta_json: inv.meta ? JSON.stringify(inv.meta) : null
    });
  }
}

/**
 * BroadcastSink: writes each invocation to multiple sinks. Used to keep
 * the JSONL trail alongside the SQL system of record as a redundant
 * on-disk audit log.
 */
export class BroadcastSink implements ObservabilitySink {
  constructor(private readonly sinks: ObservabilitySink[]) {}

  record(inv: MCPInvocation): void {
    for (const s of this.sinks) {
      try {
        s.record(inv);
      } catch (err) {
        // One sink's failure must not block another. Surfacing to
        // stderr is OK because stdout is reserved for MCP protocol.
        process.stderr.write(
          `[networkpipeline mcp-server] sink error: ${
            err instanceof Error ? err.message : String(err)
          }\n`
        );
      }
    }
  }
}

/**
 * JsonlFileSink: append-only JSONL log on disk. One line per invocation.
 * Crash-safe (uses appendFileSync) and survives across server restarts.
 *
 * Default location: `$NETWORKPIPELINE_HOME/logs/mcp_invocations.jsonl`,
 * falling back to `~/.networkpipeline/logs/mcp_invocations.jsonl`.
 *
 * No longer the V1 system of record — the SQLite `mcp_invocations`
 * table is. Kept as a redundant on-disk audit log via BroadcastSink.
 */
export class JsonlFileSink implements ObservabilitySink {
  readonly path: string;

  constructor(overridePath?: string) {
    this.path = resolveLogPath(overridePath);
    ensureDirFor(this.path);
  }

  record(inv: MCPInvocation): void {
    appendFileSync(this.path, JSON.stringify(inv) + "\n", "utf-8");
  }
}

export function resolveLogPath(override?: string): string {
  if (override && override.length > 0) return resolve(override);
  const env = process.env.NETWORKPIPELINE_LOG_PATH;
  if (env && env.length > 0) return resolve(env);
  const home = process.env.NETWORKPIPELINE_HOME ?? homedir();
  return resolve(join(home, ".networkpipeline", "logs", "mcp_invocations.jsonl"));
}

function ensureDirFor(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Build an MCPInvocation row from a dispatch outcome. Pure function,
 * easy to test, decouples observability formatting from the dispatch
 * flow itself.
 */
export function buildInvocationRecord(args: {
  id: string;
  toolName: string;
  argsHash: string;
  startedAt: Date;
  finishedAt: Date;
  outcome:
    | { ok: true; output: unknown; meta?: Record<string, unknown> }
    | {
        ok: false;
        error: {
          kind: "unknown_tool" | "validation_error" | "handler_error";
        } & Record<string, unknown>;
      };
}): MCPInvocation {
  const latency_ms = args.finishedAt.getTime() - args.startedAt.getTime();
  if (args.outcome.ok) {
    return {
      id: args.id,
      tool_name: args.toolName,
      args_hash: args.argsHash,
      result_kind: "ok",
      result_summary: summarizeOutput(args.outcome.output),
      started_at: args.startedAt.toISOString(),
      latency_ms,
      meta: args.outcome.meta
    };
  }
  return {
    id: args.id,
    tool_name: args.toolName,
    args_hash: args.argsHash,
    result_kind: args.outcome.error.kind,
    result_summary: summarizeError(args.outcome.error),
    started_at: args.startedAt.toISOString(),
    latency_ms
  };
}

function summarizeOutput(output: unknown): string {
  if (output === null || output === undefined) return "null";
  if (typeof output === "object") {
    const verdict = (output as { verdict?: unknown }).verdict;
    if (typeof verdict === "string") return `verdict=${verdict}`;
    return "object";
  }
  return String(output).slice(0, 80);
}

function summarizeError(error: { kind: string } & Record<string, unknown>): string {
  if (error.kind === "validation_error") {
    const issues = (error.issues as Array<{ path: string[] }>) ?? [];
    return `validation: ${issues.length} issue(s)`;
  }
  if (error.kind === "unknown_tool") return `unknown tool`;
  if (typeof error.message === "string") return error.message.slice(0, 200);
  return error.kind;
}
