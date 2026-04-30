import { z } from "zod";
import type { SavedSearchRow } from "@networkpipeline/db";
import type { Runtime } from "../runtime.js";
import { type ToolDefinition } from "../registry.js";

const inputSchema = z
  .object({
    limit: z.number().int().positive().max(500).optional()
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export type ListSavedSearchesOutput = {
  saved_searches: SavedSearchRow[];
};

/**
 * list_saved_searches — recent-first listing of saved_searches rows.
 * Defaults to the repository's default limit (50). Recency uses
 * last_run_at NULLS LAST, with created_at as the never-run fallback.
 */
export function makeListSavedSearchesTool(
  runtime: Runtime
): ToolDefinition<Input, ListSavedSearchesOutput> {
  return {
    name: "list_saved_searches",
    description:
      "List saved_searches rows ordered by last_run_at desc (NULLS LAST). Optional limit override.",
    inputSchema,
    handler: async (input) => {
      const rows = runtime.repositories.savedSearches.list(input.limit ?? 50);
      return { saved_searches: rows };
    }
  };
}
