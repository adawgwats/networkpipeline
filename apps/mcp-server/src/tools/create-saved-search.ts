import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SavedSearchRow } from "@networkpipeline/db";
import type { Runtime } from "../runtime.js";
import { type ToolDefinition } from "../registry.js";

const cadenceSchema = z.enum(["on_demand", "daily", "weekly"]);

const inputSchema = z
  .object({
    label: z.string().min(1),
    sources_json: z.string().min(1),
    queries_json: z.string().min(1),
    criteria_overlay_path: z.string().nullable().optional(),
    cadence: cadenceSchema.optional()
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export type CreateSavedSearchOutput = SavedSearchRow;

/**
 * create_saved_search — persists a new saved_searches row. Generates
 * a fresh ULID-style id and stamps created_at / updated_at to now.
 *
 * Inputs are deliberately unprocessed JSON strings (sources_json,
 * queries_json) — we let the caller construct the canonical JSON so
 * the row matches `SavedSearchRow` exactly. Validation of the inner
 * shapes (Source enum, per-source query) happens at run time when
 * connectors consume them.
 */
export function makeCreateSavedSearchTool(
  runtime: Runtime
): ToolDefinition<Input, CreateSavedSearchOutput> {
  return {
    name: "create_saved_search",
    description:
      "Create a new saved_search row. Returns the persisted row. JSON columns (sources_json, queries_json) are stored as-is and parsed at run time when connectors consume them.",
    inputSchema,
    handler: async (input) => {
      const id = randomUUID();
      const now = new Date().toISOString();
      const row: SavedSearchRow = {
        id,
        label: input.label,
        sources_json: input.sources_json,
        queries_json: input.queries_json,
        criteria_overlay_path: input.criteria_overlay_path ?? null,
        cadence: input.cadence ?? "on_demand",
        created_at: now,
        updated_at: now,
        last_run_at: null
      };
      runtime.repositories.savedSearches.insert(row);
      return row;
    }
  };
}
