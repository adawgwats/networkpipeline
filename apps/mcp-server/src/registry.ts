import { z, type ZodType } from "zod";

/**
 * ToolDefinition is the transport-agnostic shape we register tools as.
 * The server (server.ts) translates these into MCP SDK registrations and
 * the test harness consumes them directly without going through the SDK.
 */
export type ToolContext = {
  /** Stable invocation id for observability tracing. */
  invocationId: string;
};

export type ToolDefinition<TInput, TOutput> = {
  name: string;
  description: string;
  /**
   * Zod schema for the tool input. The SDK accepts a Zod shape (record
   * of named Zod types), so handlers expecting an object should pass an
   * object schema. Validation runs BEFORE the handler is called.
   */
  inputSchema: ZodType<TInput>;
  /**
   * Optional output schema. Used by tests to assert handler return shape.
   * Not currently passed to the MCP SDK (the SDK formats output as
   * content blocks).
   */
  outputSchema?: ZodType<TOutput>;
  handler: (input: TInput, ctx: ToolContext) => Promise<TOutput>;
};

export type AnyToolDefinition = ToolDefinition<unknown, unknown>;

/**
 * In-memory registry. The server wires every entry into the MCP SDK at
 * startup; tests call `dispatch` directly to avoid spinning up a real
 * server.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, AnyToolDefinition>();

  register<TInput, TOutput>(def: ToolDefinition<TInput, TOutput>): void {
    if (this.tools.has(def.name)) {
      throw new Error(`Tool already registered: ${def.name}`);
    }
    this.tools.set(def.name, def as AnyToolDefinition);
  }

  list(): AnyToolDefinition[] {
    return [...this.tools.values()];
  }

  get(name: string): AnyToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * Dispatch by name with raw (unvalidated) input. Validates against the
   * tool's input schema and surfaces a structured error on validation
   * failure rather than throwing a raw Zod error.
   */
  async dispatch(
    name: string,
    rawInput: unknown,
    ctx: ToolContext
  ): Promise<{ ok: true; output: unknown } | { ok: false; error: DispatchError }> {
    const def = this.tools.get(name);
    if (!def) {
      return {
        ok: false,
        error: { kind: "unknown_tool", tool: name }
      };
    }

    const parsed = def.inputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          kind: "validation_error",
          tool: name,
          issues: parsed.error.issues.map((i) => ({
            path: i.path.map(String),
            message: i.message
          }))
        }
      };
    }

    try {
      const output = await def.handler(parsed.data, ctx);
      return { ok: true, output };
    } catch (err) {
      return {
        ok: false,
        error: {
          kind: "handler_error",
          tool: name,
          message: err instanceof Error ? err.message : String(err)
        }
      };
    }
  }
}

export type DispatchError =
  | { kind: "unknown_tool"; tool: string }
  | {
      kind: "validation_error";
      tool: string;
      issues: { path: string[]; message: string }[];
    }
  | { kind: "handler_error"; tool: string; message: string };

/**
 * Helper: build an object Zod schema from a record of named types. Used
 * by tool definitions so handler input is typed object, not opaque.
 */
export function objectInput<T extends Record<string, ZodType<unknown>>>(
  shape: T
): ZodType<{ [K in keyof T]: z.infer<T[K]> }> {
  return z.object(shape).strict() as ZodType<{ [K in keyof T]: z.infer<T[K]> }>;
}
