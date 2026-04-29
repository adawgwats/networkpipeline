import { createHash, randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";
import type { Runtime } from "./runtime.js";
import {
  buildInvocationRecord,
  SqliteSink,
  type ObservabilitySink
} from "./observability.js";
import { ToolRegistry } from "./registry.js";
import { makeEvaluateJobTool } from "./tools/evaluate-job.js";

export type BuildServerOptions = {
  runtime: Runtime;
  /** Defaults to SqliteSink writing through runtime.repositories.mcpInvocations. */
  observability?: ObservabilitySink;
  /** Override server name (default: networkpipeline). */
  name?: string;
  /** Override server version (default: package.json). */
  version?: string;
};

/**
 * Build the configured MCP server WITH a transport-agnostic surface.
 *
 * The returned object exposes:
 *   - `server`: the underlying SDK McpServer, ready to connect to a
 *     transport (stdio, HTTP, etc.).
 *   - `registry`: the in-process tool registry, used by tests for
 *     direct dispatch without spinning up a real transport.
 *
 * Every SDK-side tool registration delegates to `registry.dispatch` so
 * the SDK and the test harness exercise identical code paths.
 */
export function buildServer(options: BuildServerOptions) {
  const sink =
    options.observability ??
    new SqliteSink(options.runtime.repositories.mcpInvocations);
  const registry = new ToolRegistry();

  // Register V1 tools. Future tools (find_intro_paths, draft_*, etc.)
  // get added here as they land.
  registry.register(makeEvaluateJobTool(options.runtime));

  const server = new McpServer({
    name: options.name ?? "networkpipeline",
    version: options.version ?? "0.1.0"
  });

  for (const tool of registry.list()) {
    // Best-effort introspection of the input shape. Object schemas are
    // the common case and surface field-level validation in the SDK UX.
    // For non-object schemas, the SDK falls back to opaque input.
    const inputShape = extractObjectShape(tool.inputSchema);

    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: inputShape
      },
      async (rawInput: unknown) => {
        const startedAt = new Date();
        const invocationId = randomUUID();
        const argsHash = hashJson(rawInput);

        const outcome = await registry.dispatch(tool.name, rawInput, {
          invocationId
        });

        const finishedAt = new Date();
        sink.record(
          buildInvocationRecord({
            id: invocationId,
            toolName: tool.name,
            argsHash,
            startedAt,
            finishedAt,
            outcome: outcome.ok
              ? { ok: true, output: outcome.output }
              : { ok: false, error: outcome.error as never }
          })
        );

        if (!outcome.ok) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(outcome.error, null, 2)
              }
            ]
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(outcome.output, null, 2)
            }
          ]
        };
      }
    );
  }

  return { server, registry, sink };
}

function hashJson(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value ?? null))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Best-effort extraction of `{ field: ZodType }` from a Zod object
 * schema. Used to surface field-level validation in the MCP SDK's UX.
 * Falls back to undefined for non-object schemas so the SDK accepts
 * opaque input.
 *
 * The returned shape is structurally a ZodRawShape; the SDK's
 * `registerTool` accepts that for `inputSchema`.
 */
function extractObjectShape(schema: unknown): ZodRawShape | undefined {
  // Zod object schemas expose `_def.shape` (a thunk in v3) or a `shape`
  // getter. Both lead to the same object.
  const maybeShape =
    (schema as { shape?: unknown })?.shape ??
    (schema as { _def?: { shape?: () => Record<string, unknown> } })?._def
      ?.shape;
  if (typeof maybeShape === "function") {
    try {
      const shape = (maybeShape as () => unknown)();
      if (shape && typeof shape === "object") {
        return shape as ZodRawShape;
      }
    } catch {
      return undefined;
    }
  }
  if (maybeShape && typeof maybeShape === "object") {
    return maybeShape as ZodRawShape;
  }
  return undefined;
}
