import Database from "better-sqlite3";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { CITIES } from "../ingest/cities.js";

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
 * Exported for tests that exercise the backfills against pre-migration rows.
 */
export function migrate(d: Database.Database) {
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
  addColumn("merchants", "timezone", "timezone TEXT"); // IANA zone; naive booking datetimes are merchant-local
  // Backfill rows imported before the column existed: city → zone from the
  // ingestion city configs; the SF sandbox seeds get their real zone. New
  // imports carry timezone per record. Idempotent by the IS NULL guard.
  const cityTz: Record<string, string> = { "San Francisco, CA": "America/Los_Angeles" };
  for (const c of Object.values(CITIES)) cityTz[c.city] = c.timezone;
  const setTz = d.prepare("UPDATE merchants SET timezone = ? WHERE city = ? AND timezone IS NULL");
  for (const [city, tz] of Object.entries(cityTz)) setTz.run(tz, city);
  // P2 freshness: re-verification change signal (source phone vs verified phone).
  addColumn("merchants", "source_phone_conflict", "source_phone_conflict TEXT");
  addColumn("merchants", "source_phone_conflict_at", "source_phone_conflict_at TEXT");
  addColumn("bookings", "client_reference_id", "client_reference_id TEXT"); // idempotent place_booking (agent retry safety)
  addColumn("bookings", "request_fingerprint", "request_fingerprint TEXT");
  // Uniqueness scope is per developer key (COALESCE: NULL api_key_id rows — anonymous
  // callers — share one scope, so references should be UUIDs). Lives here, not in
  // schema.sql: on a pre-migration database schema.sql executes before the column
  // exists, and a top-level CREATE INDEX referencing it would fail the open.
  d.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_client_ref ON bookings(COALESCE(api_key_id, ''), client_reference_id) WHERE client_reference_id IS NOT NULL",
  );
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
