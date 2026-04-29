/**
 * mcp_invocations — one row per MCP tool dispatch.
 *
 * Replaces the JSONL log shipped in apps/mcp-server/observability.ts
 * with a queryable, joinable table. JSONL stays as a redundant on-disk
 * log; this table is the system of record for invocation analytics
 * (latency p95, error rate, tool-frequency distribution, etc.).
 *
 * Portability: TEXT for ISO timestamps, INTEGER for latency. No
 * SQLite-specific types so the schema works against PostgreSQL with
 * a different driver later.
 */

export type ResultKind =
  | "ok"
  | "validation_error"
  | "handler_error"
  | "unknown_tool";

export type McpInvocationRow = {
  id: string;
  tool_name: string;
  args_hash: string;
  result_kind: ResultKind;
  result_summary: string;
  /** ISO-8601 timestamp. */
  started_at: string;
  latency_ms: number;
  /** Optional opaque metadata as JSON-encoded text. */
  meta_json: string | null;
};

export type McpInvocationInsert = McpInvocationRow;
