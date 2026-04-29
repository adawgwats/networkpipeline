#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadRuntime } from "./runtime.js";
import { buildServer } from "./server.js";

/**
 * Entry point for the MCP server stdio transport.
 *
 * Usage:
 *   claude mcp add networkpipeline -- npx -y @networkpipeline/mcp-server
 *
 * Required env:
 *   ANTHROPIC_API_KEY              — for the evaluator's Claude calls.
 *
 * Optional env:
 *   NETWORKPIPELINE_HOME           — runtime data dir (default ~/.networkpipeline).
 *   NETWORKPIPELINE_CRITERIA_PATH  — override criteria.yaml location.
 *   NETWORKPIPELINE_LOG_PATH       — override mcp_invocations JSONL path.
 *   ANTHROPIC_MODEL                — override Claude model (default claude-opus-4-7).
 */
async function main(): Promise<void> {
  const runtime = await loadRuntime({
    anthropicModel: process.env.ANTHROPIC_MODEL
  });

  const { server } = buildServer({ runtime });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown — both signals close the transport cleanly so any
  // in-flight observability writes flush before exit.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void server.close().finally(() => process.exit(0));
    });
  }
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
