import type { AppDatabase } from "../connection.js";
import type {
  McpInvocationInsert,
  McpInvocationRow
} from "../schema/mcp_invocations.js";

const INSERT_SQL = `
INSERT INTO mcp_invocations
  (id, tool_name, args_hash, result_kind, result_summary, started_at, latency_ms, meta_json)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`;

const FIND_BY_ID_SQL = `SELECT * FROM mcp_invocations WHERE id = ?`;
const LIST_RECENT_SQL = `
SELECT * FROM mcp_invocations ORDER BY started_at DESC LIMIT ?
`;
const COUNT_BY_KIND_SQL = `
SELECT result_kind, COUNT(*) as n FROM mcp_invocations GROUP BY result_kind
`;

export class McpInvocationsRepository {
  private readonly insertStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly findByIdStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly listRecentStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly countByKindStmt: ReturnType<AppDatabase["prepare"]>;

  constructor(private readonly db: AppDatabase) {
    this.insertStmt = db.prepare(INSERT_SQL);
    this.findByIdStmt = db.prepare(FIND_BY_ID_SQL);
    this.listRecentStmt = db.prepare(LIST_RECENT_SQL);
    this.countByKindStmt = db.prepare(COUNT_BY_KIND_SQL);
  }

  insert(row: McpInvocationInsert): void {
    this.insertStmt.run(
      row.id,
      row.tool_name,
      row.args_hash,
      row.result_kind,
      row.result_summary,
      row.started_at,
      row.latency_ms,
      row.meta_json
    );
  }

  insertMany(rows: McpInvocationInsert[]): void {
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

  findById(id: string): McpInvocationRow | undefined {
    return this.findByIdStmt.get(id) as McpInvocationRow | undefined;
  }

  listRecent(limit = 50): McpInvocationRow[] {
    return this.listRecentStmt.all(limit) as McpInvocationRow[];
  }

  countByResultKind(): Record<string, number> {
    const rows = this.countByKindStmt.all() as Array<{
      result_kind: string;
      n: number;
    }>;
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.result_kind] = Number(r.n);
    return counts;
  }
}
