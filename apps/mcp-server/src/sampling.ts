import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SamplingDelegate } from "@networkpipeline/evaluator";

/**
 * Build a SamplingDelegate that routes evaluator LLM calls back into
 * the connected MCP client (Claude Code) via the `sampling/createMessage`
 * primitive.
 *
 * When the user runs Claude Code with NetworkPipeline registered as an
 * MCP server, every evaluator stage (extract, values, score) calls
 * `provider.generateJsonObject(...)` on a `ClaudeCodeJsonOutputProvider`,
 * which in turn calls this delegate, which sends a `sampling/createMessage`
 * request back over the stdio transport. Claude Code performs the
 * inference inside the user's existing Max-subscription session and
 * returns a `tool_use` content block. We then unwrap that block back
 * into `{ data, usage }` for the provider to validate.
 *
 * The McpServer must be connected to a transport before any sampling
 * call is dispatched; the delegate is invoked lazily (per evaluator
 * call), so as long as construction wires up the transport before the
 * first tool dispatch, ordering is fine.
 */
export function buildSamplingDelegate(server: McpServer): SamplingDelegate {
  return async (req) => {
    // Tool schema requires `type: "object"` at the top level. The Zod
    // → JSON Schema conversion already produces that shape for the
    // schemas we use; we cast through unknown to the SDK's stricter
    // shape (which requires properties values typed as `object`) since
    // our JSON schema property values are themselves objects in
    // practice and zod-to-json-schema keeps them that way.
    const inputSchema = req.inputSchema as unknown as {
      [x: string]: unknown;
      type: "object";
      properties?: { [x: string]: object };
      required?: string[];
    };

    const result = await server.server.createMessage({
      systemPrompt: req.systemPrompt,
      maxTokens: req.maxTokens ?? 4096,
      messages: [
        {
          role: "user",
          content: { type: "text", text: req.userPrompt }
        }
      ],
      tools: [
        {
          name: req.toolName,
          description: req.toolDescription,
          inputSchema
        }
      ],
      toolChoice: { mode: "required" }
    });

    // Locate the tool_use content block. With tools provided the result
    // content can be a single block or an array of blocks (parallel
    // tool calls); we only ever ask for one tool, so take the first
    // tool_use we find.
    const block = pickToolUseBlock(result.content, req.toolName);
    if (!block) {
      throw new Error(
        `sampling/createMessage returned no tool_use block for tool ${req.toolName}.`
      );
    }

    return {
      data: block.input as unknown,
      usage: {
        // The MCP sampling result surfaces `model` and `stopReason`,
        // but does NOT expose token counts — Claude Code keeps usage
        // accounting on its side. We pass through what's available
        // and let the provider fill the rest with zero defaults.
        model: result.model,
        stop_reason: result.stopReason
      }
    };
  };
}

type ToolUseBlock = {
  type: "tool_use";
  name: string;
  id: string;
  input: Record<string, unknown>;
};

/**
 * Walk the (possibly array, possibly single-block) content of a
 * sampling result and return the first matching tool_use block.
 */
function pickToolUseBlock(
  content: unknown,
  toolName: string
): ToolUseBlock | undefined {
  const blocks = Array.isArray(content) ? content : [content];
  for (const block of blocks) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "tool_use" &&
      (block as { name?: unknown }).name === toolName
    ) {
      return block as ToolUseBlock;
    }
  }
  return undefined;
}
