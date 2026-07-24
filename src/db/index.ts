import Database from "better-sqlite3";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

const here = dirname(fileURLToPath(import.meta.url));

let db: Database.Database | null = null;

/** Open (and migrate) the registry database. WAL mode so the MCP server and the API/worker process can share it. */
export function getDb(path: string = config.dbPath): Database.Database {
  if (db) return db;
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync(join(here, "schema.sql"), "utf8"));
  migrate(db);
  return db;
}

/**
 * Idempotent column additions for databases created before the column existed
 * (schema.sql only CREATEs IF NOT EXISTS — it can't retrofit live volumes).
 */
function migrate(d: Database.Database) {
  const addColumn = (table: string, column: string, ddl: string) => {
    const present = (d.pragma(`table_info(${table})`) as { name: string }[]).some((c) => c.name === column);
    if (!present) d.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  addColumn("api_keys", "created_ip", "created_ip TEXT"); // Gate B: per-IP mint limits
  addColumn("merchants", "sandbox", "sandbox INTEGER NOT NULL DEFAULT 0"); // booking guard: real imported merchants default 0 (discovery-only)
  addColumn("bookings", "notify_issue_number", "notify_issue_number INTEGER"); // note 004: operator-notification issue
  addColumn("bookings", "notify_issue_closed", "notify_issue_closed INTEGER NOT NULL DEFAULT 0");
  // Cutover: pre-guard synthetic seeds (the SF demo corpus, created before the
  // sandbox column existed) are test data and must never be served flagged as
  // real merchants. They become the explicit sandbox set; the real three-city
  // corpus never has this city value. Idempotent by the WHERE clause.
  d.prepare("UPDATE merchants SET sandbox = 1 WHERE city = 'San Francisco, CA' AND sandbox = 0").run();
}

/** Test helper: fresh in-memory database, independent of the singleton. */
export function openTestDb(): Database.Database {
  const mem = new Database(":memory:");
  mem.pragma("foreign_keys = ON");
  mem.exec(readFileSync(join(here, "schema.sql"), "utf8"));
  migrate(mem);
  return mem;
}

export function now(): string {
  return new Date().toISOString();
}
