import { z } from "zod";
import type { Runtime } from "../runtime.js";
import { type ToolDefinition } from "../registry.js";

const inputSchema = z
  .object({
    id: z.string().min(1)
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export type DeleteSavedSearchOutput = {
  id: string;
  deleted: boolean;
};

/**
 * delete_saved_search — hard-deletes the saved_searches row.
 *
 * Does NOT touch search_runs or discovered_postings. Those are
 * append-only audit records — keeping them after the parent
 * SavedSearch is gone is intentional so historical run accounting
 * remains queryable.
 *
 * Idempotent: deleting a missing id returns deleted=false but does
 * not error.
 */
export function makeDeleteSavedSearchTool(
  runtime: Runtime
): ToolDefinition<Input, DeleteSavedSearchOutput> {
  return {
    name: "delete_saved_search",
    description:
      "Hard-delete a saved_searches row by id. Idempotent. Does not cascade to search_runs / discovered_postings (those are append-only audit records).",
    inputSchema,
    handler: async (input) => {
      const existed = Boolean(
        runtime.repositories.savedSearches.findById(input.id)
      );
      runtime.repositories.savedSearches.deleteById(input.id);
      return { id: input.id, deleted: existed };
    }
  };
}
