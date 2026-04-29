import type { AppDatabase } from "../connection.js";
import type {
  ProviderRunInsert,
  ProviderRunRow
} from "../schema/provider_runs.js";

export type CacheStats = {
  total_calls: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_creation_tokens: number;
  total_cache_read_tokens: number;
  /**
   * cache_read / (cache_read + cache_creation). Null when no cacheable
   * inputs exist (denominator zero).
   */
  cache_hit_ratio: number | null;
  total_cost_usd_cents: number;
};

const INSERT_SQL = `
INSERT INTO provider_runs (
  id, provider, model, prompt_id, started_at, latency_ms,
  input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
  cost_usd_cents, stop_reason, retries, mcp_invocation_id, job_evaluation_id
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const FIND_BY_ID_SQL = `SELECT * FROM provider_runs WHERE id = ?`;
const BY_MCP_INVOCATION_SQL = `
SELECT * FROM provider_runs WHERE mcp_invocation_id = ? ORDER BY started_at ASC
`;
const BY_JOB_EVAL_SQL = `
SELECT * FROM provider_runs WHERE job_evaluation_id = ? ORDER BY started_at ASC
`;
const BY_PROMPT_ID_SQL = `
SELECT * FROM provider_runs WHERE prompt_id = ? ORDER BY started_at DESC LIMIT ?
`;

const STATS_BASE_SQL = `
SELECT
  COUNT(*) AS total_calls,
  COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
  COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
  COALESCE(SUM(cache_creation_tokens), 0) AS total_cache_creation_tokens,
  COALESCE(SUM(cache_read_tokens), 0) AS total_cache_read_tokens,
  COALESCE(SUM(cost_usd_cents), 0) AS total_cost_usd_cents
FROM provider_runs
WHERE provider != 'skipped'
`;

export class ProviderRunsRepository {
  private readonly insertStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly findByIdStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly byMcpStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly byEvalStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly byPromptStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly statsAllStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly statsByPromptStmt: ReturnType<AppDatabase["prepare"]>;

  constructor(private readonly db: AppDatabase) {
    this.insertStmt = db.prepare(INSERT_SQL);
    this.findByIdStmt = db.prepare(FIND_BY_ID_SQL);
    this.byMcpStmt = db.prepare(BY_MCP_INVOCATION_SQL);
    this.byEvalStmt = db.prepare(BY_JOB_EVAL_SQL);
    this.byPromptStmt = db.prepare(BY_PROMPT_ID_SQL);
    this.statsAllStmt = db.prepare(STATS_BASE_SQL);
    this.statsByPromptStmt = db.prepare(
      `${STATS_BASE_SQL} AND prompt_id = ?`
    );
  }

  insert(row: ProviderRunInsert): void {
    this.insertStmt.run(
      row.id,
      row.provider,
      row.model,
      row.prompt_id,
      row.started_at,
      row.latency_ms,
      row.input_tokens,
      row.output_tokens,
      row.cache_creation_tokens,
      row.cache_read_tokens,
      row.cost_usd_cents,
      row.stop_reason,
      row.retries,
      row.mcp_invocation_id,
      row.job_evaluation_id
    );
  }

  insertMany(rows: ProviderRunInsert[]): void {
    if (rows.length === 0) return;
    this.db.exec("BEGIN");
    try {
      for (const row of rows) this.insert(row);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  findById(id: string): ProviderRunRow | undefined {
    return this.findByIdStmt.get(id) as ProviderRunRow | undefined;
  }

  listByMcpInvocation(invocationId: string): ProviderRunRow[] {
    return this.byMcpStmt.all(invocationId) as ProviderRunRow[];
  }

  listByJobEvaluation(evaluationId: string): ProviderRunRow[] {
    return this.byEvalStmt.all(evaluationId) as ProviderRunRow[];
  }

  listByPromptId(promptId: string, limit = 100): ProviderRunRow[] {
    return this.byPromptStmt.all(promptId, limit) as ProviderRunRow[];
  }

  /**
   * Aggregate cost + cache stats. Filters out runs from the "skipped"
   * provider — those are accounting placeholders for short-circuited
   * stages and should not pollute cost or cache metrics.
   */
  cacheStats(opts: { promptId?: string } = {}): CacheStats {
    const row = (
      opts.promptId
        ? this.statsByPromptStmt.get(opts.promptId)
        : this.statsAllStmt.get()
    ) as
      | {
          total_calls: number;
          total_input_tokens: number;
          total_output_tokens: number;
          total_cache_creation_tokens: number;
          total_cache_read_tokens: number;
          total_cost_usd_cents: number;
        }
      | undefined;

    const r = row ?? {
      total_calls: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_creation_tokens: 0,
      total_cache_read_tokens: 0,
      total_cost_usd_cents: 0
    };

    const denominator =
      Number(r.total_cache_creation_tokens) + Number(r.total_cache_read_tokens);

    return {
      total_calls: Number(r.total_calls),
      total_input_tokens: Number(r.total_input_tokens),
      total_output_tokens: Number(r.total_output_tokens),
      total_cache_creation_tokens: Number(r.total_cache_creation_tokens),
      total_cache_read_tokens: Number(r.total_cache_read_tokens),
      cache_hit_ratio:
        denominator === 0
          ? null
          : Number(r.total_cache_read_tokens) / denominator,
      total_cost_usd_cents: Number(r.total_cost_usd_cents)
    };
  }
}
