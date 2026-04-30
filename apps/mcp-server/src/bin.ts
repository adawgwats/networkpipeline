#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadRuntime, type ProviderKind } from "./runtime.js";
import { buildServer } from "./server.js";
import { buildSamplingDelegate } from "./sampling.js";

/**
 * Entry point for the MCP server stdio transport.
 *
 * Usage:
 *   claude mcp add networkpipeline -- npx -y @networkpipeline/mcp-server
 *
 * Provider selection (NETWORKPIPELINE_PROVIDER):
 *   "claude_code" — route LLM calls back through Claude Code via MCP
 *                   sampling. No API key. Billed against Max subscription.
 *   "anthropic"   — direct Anthropic API calls. Requires ANTHROPIC_API_KEY.
 *   "auto" (default) — Claude Code when running under an MCP client that
 *                      supports sampling, Anthropic API otherwise.
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

  // Construct the SDK server up front so we can hand its `createMessage`
  // primitive to the runtime as a SamplingDelegate. This inverts the
  // previous load-runtime-then-build-server order: sampling is a server-
  // to-client capability that depends on the SDK server existing first.
  const sdkServer = new McpServer({
    name: "networkpipeline",
    version: "0.1.0"
  });

  const samplingDelegate = buildSamplingDelegate(sdkServer);

  const runtime = await loadRuntime({
    anthropicModel: process.env.ANTHROPIC_MODEL,
    providerKind,
    samplingDelegate
  });

  // Surface which provider the runtime resolved to, so users can spot
  // misconfigurations (e.g., expecting the Max-billed path but landing
  // on the API path because no transport-side sampling is wired). stderr
  // — stdout is the protocol channel.
  const resolved = describeProvider(runtime.provider.constructor.name);
  process.stderr.write(
    `[networkpipeline mcp-server] provider=${resolved} (kind=${providerKind ?? "auto"})\n`
  );

  // buildServer is given the existing McpServer to register tools onto,
  // rather than constructing a fresh one. This keeps the sampling
  // delegate's reference valid.
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
  if (normalized === "claude_code" || normalized === "anthropic" || normalized === "auto") {
    return normalized;
  }
  process.stderr.write(
    `[networkpipeline mcp-server] warning: unknown NETWORKPIPELINE_PROVIDER=${raw}, defaulting to auto\n`
  );
  return undefined;
}

function describeProvider(ctorName: string): string {
  if (ctorName === "ClaudeCodeJsonOutputProvider") return "claude_code";
  if (ctorName === "AnthropicJsonOutputProvider") return "anthropic";
  return ctorName;
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
