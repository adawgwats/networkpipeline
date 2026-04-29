import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { APPLY_SCHEMA_DDL } from "./schema/index.js";

/**
 * AppDatabase is the typed wrapper around node:sqlite's DatabaseSync.
 * Repositories take this type so we can swap implementations later
 * without rewriting call sites.
 */
export type AppDatabase = DatabaseSync;

export type OpenDbOptions = {
  /**
   * Path to the SQLite file. Pass ":memory:" for ephemeral DBs.
   * Defaults to `$NETWORKPIPELINE_HOME/db/networkpipeline.sqlite`.
   */
  path?: string;
  /**
   * Apply the schema after opening (idempotent). Defaults to true.
   * Set to false if you're managing migrations externally.
   */
  applySchema?: boolean;
  /**
   * Enable WAL mode for the SQLite connection. Defaults to true for
   * file-backed DBs, false for in-memory DBs (WAL is meaningless on
   * in-memory anyway).
   */
  walMode?: boolean;
};

export type Connection = {
  db: AppDatabase;
  /** Resolved file path (or ":memory:"). */
  path: string;
  close: () => void;
};

/**
 * Open (or create) a NetworkPipeline SQLite database. Creates the
 * directory if needed, opens the file, optionally applies the schema,
 * and returns a typed handle plus a close fn.
 *
 * Uses Node's built-in `node:sqlite` (stable as of Node 22+) so we
 * don't need any native dependencies. Sync API matches the simple
 * single-process write pattern of a local-first product.
 *
 * Lifetime: callers own the connection. The MCP server constructs one
 * at boot and closes it on shutdown. Tests construct per-test
 * in-memory DBs and close in `after` hooks.
 */
export function openDb(options: OpenDbOptions = {}): Connection {
  const path = resolveDbPath(options.path);
  if (path !== ":memory:") {
    ensureDirFor(path);
  }

  const db = new DatabaseSync(path);
  const isFileBacked = path !== ":memory:";
  const wantsWal = options.walMode ?? isFileBacked;

  // Foreign keys are off by default in SQLite. Enabling now so future
  // CRM tables with explicit FK constraints behave correctly without a
  // global toggle later.
  db.exec("PRAGMA foreign_keys = ON;");

  if (wantsWal) {
    db.exec("PRAGMA journal_mode = WAL;");
  }

  if (options.applySchema ?? true) {
    applySchema(db);
  }

  return {
    db,
    path,
    close: () => db.close()
  };
}

/**
 * Apply every DDL statement from `APPLY_SCHEMA_DDL`. Each statement is
 * idempotent (CREATE TABLE/INDEX IF NOT EXISTS), so this can be called
 * repeatedly without harm.
 */
export function applySchema(db: AppDatabase): void {
  db.exec("BEGIN");
  try {
    for (const stmt of APPLY_SCHEMA_DDL) {
      db.exec(stmt);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function resolveDbPath(override?: string): string {
  if (override !== undefined) return override;
  const env = process.env.NETWORKPIPELINE_DB_PATH;
  if (env && env.length > 0) {
    return env === ":memory:" ? env : resolve(env);
  }
  const home = process.env.NETWORKPIPELINE_HOME ?? homedir();
  return resolve(join(home, ".networkpipeline", "db", "networkpipeline.sqlite"));
}

function ensureDirFor(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
