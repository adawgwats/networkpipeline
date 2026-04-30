import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SamplingDelegate } from "@networkpipeline/evaluator";

/**
 * Build a SamplingDelegate that routes evaluator LLM calls back into
 * the connected MCP client (Claude Code) via the `sampling/createMessage`
 * primitive.
 *
 * IMPORTANT: this delegate uses **plain-text sampling**, not the
 * tool-use sampling sub-capability. Claude Code (as of v2.1.123)
 * advertises `sampling/createMessage` but does NOT advertise the
 * `sampling.tools` capability, so a server that requests tools in its
 * sampling call gets `Client does not support sampling tools capability`.
 *
 * The trade-off: instead of forcing structured output via a tool
 * `input_schema`, we embed the JSON Schema in the system prompt and
 * instruct the model to emit a single JSON object. The provider then
 * validates the parsed JSON with Zod (same retry-on-failure semantics
 * as the tool-use path). Slightly more brittle to model output drift,
 * but compatible with every MCP client that implements basic sampling.
 *
 * The McpServer must be connected to a transport before any sampling
 * call is dispatched; the delegate is invoked lazily (per evaluator
 * call), so as long as construction wires up the transport before the
 * first tool dispatch, ordering is fine.
 */
export function buildSamplingDelegate(server: McpServer): SamplingDelegate {
  return async (req) => {
    // Compose a system prompt that includes the JSON Schema and tells
    // the model to output ONLY a JSON object matching it. The original
    // systemPrompt (extract / values / score instructions) stays intact;
    // we append the schema-output discipline below it.
    const composedSystem = `${req.systemPrompt}

# Output format

You MUST respond with a single JSON object that conforms to the JSON Schema below. Output ONLY the JSON object — no prose, no markdown code fences, no commentary, no explanations. The first character of your response must be \`{\` and the last must be \`}\`.

JSON Schema for the response object:
\`\`\`json
${JSON.stringify(req.inputSchema, null, 2)}
\`\`\``;

    const result = await server.server.createMessage({
      systemPrompt: composedSystem,
      maxTokens: req.maxTokens ?? 4096,
      messages: [
        {
          role: "user",
          content: { type: "text", text: req.userPrompt }
        }
      ]
    });

    const text = extractText(result.content);
    if (text === undefined) {
      throw new Error(
        `sampling/createMessage returned no text content (result.content kind: ${describeContent(result.content)})`
      );
    }

    const parsed = parseJsonObject(text);
    if (parsed === null) {
      throw new Error(
        `sampling/createMessage response was not valid JSON. First 500 chars: ${text.slice(0, 500)}`
      );
    }

    return {
      data: parsed,
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

/**
 * MCP sampling result `content` is either a single block or an array
 * of blocks (parallel responses). For plain-text sampling we expect a
 * single text block; we walk both shapes defensively.
 */
function extractText(content: unknown): string | undefined {
  const blocks = Array.isArray(content) ? content : [content];
  for (const block of blocks) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text"
    ) {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") return text;
    }
  }
  return undefined;
}

function describeContent(content: unknown): string {
  if (content === null || content === undefined) return "null";
  if (Array.isArray(content)) {
    return `array of ${content.length} blocks (${content
      .map((b) =>
        b && typeof b === "object" && (b as { type?: unknown }).type
          ? String((b as { type: unknown }).type)
          : "unknown"
      )
      .join(", ")})`;
  }
  if (typeof content === "object") {
    const t = (content as { type?: unknown }).type;
    return typeof t === "string" ? `single ${t} block` : "single block (no type)";
  }
  return typeof content;
}

/**
 * Parse a JSON object from model output, tolerantly. Strips:
 *  - leading/trailing whitespace
 *  - one wrapping markdown code fence (```json or ```)
 * Falls back to extracting the first balanced `{...}` substring if the
 * model emitted prose around it.
 *
 * Returns the parsed value (object or array) on success, `null` on
 * unrecoverable parse failure.
 */
function parseJsonObject(text: string): unknown {
  let cleaned = text.trim();

  // Strip ```json ... ``` or ``` ... ``` fences.
  const fenced = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenced) cleaned = fenced[1].trim();

  // Direct parse first.
  try {
    return JSON.parse(cleaned);
  } catch {
    // Fallback: hunt for the first `{` and slice through its matching `}`.
    const start = cleaned.indexOf("{");
    if (start === -1) return null;
    const candidate = sliceBalanced(cleaned, start);
    if (candidate === null) return null;
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  }
}

/**
 * Walk forward from `start` (which must be `{` or `[`) and return the
 * substring through the matching closing brace, accounting for string
 * literals so braces inside strings don't unbalance the count.
 */
function sliceBalanced(text: string, start: number): string | null {
  const open = text.charAt(start);
  const close = open === "{" ? "}" : open === "[" ? "]" : null;
  if (close === null) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text.charAt(i);
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
