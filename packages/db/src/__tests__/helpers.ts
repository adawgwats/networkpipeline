import { openDb, type Connection } from "../connection.js";

/**
 * Creates an isolated in-memory SQLite database with the schema applied.
 * Each test gets a fresh DB so tests are independent.
 */
export function makeTestDb(): Connection {
  return openDb({ path: ":memory:", applySchema: true });
}
