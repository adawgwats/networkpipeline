import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
 * JsonlFileSink: append-only JSONL log on disk. One line per invocation.
 * Crash-safe (uses appendFileSync) and survives across server restarts.
 *
 * Default location: `$NETWORKPIPELINE_HOME/logs/mcp_invocations.jsonl`,
 * falling back to `~/.networkpipeline/logs/mcp_invocations.jsonl`.
 *
 * Will be migrated to SQL once schema work in #3 lands. The on-disk
 * JSONL trail will remain as a backup-of-record for the eval harness.
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
