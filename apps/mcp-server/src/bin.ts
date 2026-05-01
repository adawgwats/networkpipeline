#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadRuntime, type ProviderKind } from "./runtime.js";
import { buildServer } from "./server.js";

/**
 * Entry point for the MCP server stdio transport.
 *
 * Usage:
 *   claude mcp add networkpipeline -- npx -y @networkpipeline/mcp-server
 *
 * Provider selection (NETWORKPIPELINE_PROVIDER):
 *   "callback" — no in-process LLM. Evaluation tools return
 *                `pending_llm_call` payloads to Claude Code, which
 *                generates the JSON in its conversation and resumes via
 *                `record_llm_result`. Default in Claude Code; bills
 *                against the user's Max subscription.
 *   "anthropic" — direct Anthropic API calls. Requires ANTHROPIC_API_KEY.
 *                 Used for CI / automation.
 *   "auto" (default) — "anthropic" if ANTHROPIC_API_KEY is set, else
 *                      "callback".
 *
 * Optional env:
 *   NETWORKPIPELINE_HOME           — runtime data dir (default ~/.networkpipeline).
 *   NETWORKPIPELINE_CRITERIA_PATH  — override criteria.yaml location.
 *   NETWORKPIPELINE_LOG_PATH       — override mcp_invocations JSONL path.
 *   NETWORKPIPELINE_PROVIDER       — provider strategy (see above).
 *   ANTHROPIC_API_KEY              — required only for the "anthropic" path.
 *   ANTHROPIC_MODEL                — override Claude model for the API path.
 */
async function main(): Promise<void> {
  const providerKind = parseProviderKind(process.env.NETWORKPIPELINE_PROVIDER);

  const runtime = await loadRuntime({
    anthropicModel: process.env.ANTHROPIC_MODEL,
    providerKind
  });

  // Surface which provider the runtime resolved to. stderr — stdout is
  // the protocol channel.
  const resolved = runtime.provider === null ? "callback" : "anthropic";
  process.stderr.write(
    `[networkpipeline mcp-server] provider=${resolved} (kind=${providerKind ?? "auto"})\n`
  );

  const sdkServer = new McpServer({
    name: "networkpipeline",
    version: "0.1.0"
  });
  const { server } = buildServer({
    runtime,
    existingServer: sdkServer
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown — close the transport, then close the SQLite
  // connection so WAL checkpoints land before the process exits.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void server.close().finally(() => {
        try {
          runtime.connection.close();
        } catch {
          // best effort; process is exiting anyway
        }
        process.exit(0);
      });
    });
  }
}

function parseProviderKind(raw: string | undefined): ProviderKind | undefined {
  if (!raw) return undefined;
  const normalized = raw.toLowerCase();
  if (normalized === "callback" || normalized === "anthropic" || normalized === "auto") {
    return normalized;
  }
  process.stderr.write(
    `[networkpipeline mcp-server] warning: unknown NETWORKPIPELINE_PROVIDER=${raw}, defaulting to auto\n`
  );
  return undefined;
}

main().catch((err) => {
  // stdio transport assumes stdout is reserved for protocol messages, so
  // boot errors must go to stderr or they corrupt the wire format.
  process.stderr.write(
    `[networkpipeline mcp-server] fatal: ${
      err instanceof Error ? err.message : String(err)
    }\n`
  );
  process.exit(1);
});
