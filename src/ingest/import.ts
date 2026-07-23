/**
 * Release → SQLite import (the last pipeline stage before serving).
 *
 *   tsx src/ingest/import.ts --release data/releases/2026-07-16-hk [--db data/registry.db]
 *
 * Design rules:
 *  - Checksum-verified: refuses a release whose NDJSON doesn't match its manifest.
 *  - UPSERT, never delete: ops-owned columns (opt_out*, phone_verified_at,
 *    verification_status, annoyance_count, human_call_flag_reason) are preserved
 *    on update — REQ-ING-4 opt-outs and REQ-ING-2 verification survive
 *    re-imports. Merchants absent from a newer release are NOT removed here;
 *    closure detection is the P2 freshness engine's job, with its own audit trail.
 *  - Ingestion provenance (sources listed in the manifest) is refreshed per
 *    import; verification_call/ops_edit provenance rows are never touched.
 *  - Refuses any record claiming verification at import time (defense in depth —
 *    the release validator already fails closed on this).
 *
 * Importing into the LIVE volume is a deliberate ops action gated on the
 * D1 synthetic→real cutover decision — this script
 * only ever touches the database path it is explicitly pointed at.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { getDb } from "../db/index.js";
import { config } from "../config.js";
import { sha256Hex } from "./normalize.js";
import type { ReleaseManifest, ReleaseMerchant } from "./types.js";

export interface ImportResult {
  city: string;
  release: string;
  inserted: number;
  updated: number;
  provenance_rows: number;
}

export async function importRelease(db: Database, releaseDir: string): Promise<ImportResult> {
  const manifest = JSON.parse(await readFile(join(releaseDir, "manifest.json"), "utf8")) as ReleaseManifest;
  const ndjson = await readFile(join(releaseDir, manifest.ndjson_file), "utf8");

  const checksum = sha256Hex(ndjson);
  if (checksum !== manifest.checksum_sha256) {
    throw new Error(
      `release ${manifest.release}: checksum mismatch (manifest ${manifest.checksum_sha256}, file ${checksum}) — refusing to import`,
    );
  }

  const merchants = ndjson
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ReleaseMerchant);

  for (const m of merchants) {
    if (m.verification_status !== "unverified" || m.phone_verified_at !== null || m.bookable) {
      throw new Error(`release ${manifest.release}: record ${m.merchant_id} claims verification at import — refusing`);
    }
  }

  const sourceKeys = manifest.sources.map((s) => s.source);
  const stamp = `${manifest.generated_at}T00:00:00Z`;

  const exists = db.prepare("SELECT 1 FROM merchants WHERE merchant_id = ?");
  const upsert = db.prepare(`
    INSERT INTO merchants (
      merchant_id, name, aliases, category, cuisine_tags, attribute_tags,
      address, neighborhood, city, lat, lng, phone_primary, phone_verified_at,
      hours, holiday_exceptions, price_band, reservation_policy, requires_deposit,
      fulfillment_channel, languages, verification_status, opt_out,
      max_party_size, created_at, updated_at
    ) VALUES (
      @merchant_id, @name, @aliases, @category, @cuisine_tags, @attribute_tags,
      @address, @neighborhood, @city, @lat, @lng, @phone_primary, NULL,
      @hours, @holiday_exceptions, @price_band, @reservation_policy, @requires_deposit,
      @fulfillment_channel, @languages, 'unverified', 0,
      @max_party_size, @stamp, @stamp
    )
    ON CONFLICT(merchant_id) DO UPDATE SET
      name = excluded.name,
      aliases = excluded.aliases,
      cuisine_tags = excluded.cuisine_tags,
      address = excluded.address,
      neighborhood = excluded.neighborhood,
      city = excluded.city,
      lat = excluded.lat,
      lng = excluded.lng,
      -- a verified phone is never replaced by a source phone: that would break
      -- the phone_verified_at pairing. Source-side phone changes on verified
      -- merchants are a P2 re-verification trigger, not a silent overwrite.
      phone_primary = CASE WHEN merchants.phone_verified_at IS NULL
                           THEN excluded.phone_primary ELSE merchants.phone_primary END,
      updated_at = excluded.updated_at
    -- ops/verification-owned columns deliberately absent from the update list:
    -- phone_verified_at, verification_status, opt_out, opt_out_at, annoyance_count,
    -- human_call_flag_reason, attribute_tags, hours, reservation_policy,
    -- price_band, languages, max_party_size (release values for these are
    -- unsourced defaults or absent — they must not clobber verified data)
  `);
  const clearIngestProvenance = db.prepare(
    `DELETE FROM provenance WHERE merchant_id = ? AND source IN (${sourceKeys.map(() => "?").join(",")})`,
  );
  const insertProvenance = db.prepare(
    "INSERT INTO provenance (merchant_id, field, source, detail, recorded_at) VALUES (?, ?, ?, ?, ?)",
  );

  const result: ImportResult = {
    city: manifest.city,
    release: manifest.release,
    inserted: 0,
    updated: 0,
    provenance_rows: 0,
  };

  db.transaction(() => {
    for (const m of merchants) {
      const already = exists.get(m.merchant_id) !== undefined;
      upsert.run({
        merchant_id: m.merchant_id,
        name: m.name,
        aliases: JSON.stringify(m.aliases),
        category: m.category,
        cuisine_tags: JSON.stringify(m.cuisine_tags),
        attribute_tags: JSON.stringify(m.attribute_tags),
        address: m.location.address,
        neighborhood: m.location.neighborhood,
        city: m.location.city,
        lat: m.location.lat,
        lng: m.location.lng,
        phone_primary: m.phone_primary,
        hours: JSON.stringify(m.hours),
        holiday_exceptions: JSON.stringify(m.holiday_exceptions),
        price_band: m.price_band,
        reservation_policy: m.reservation_policy,
        requires_deposit: m.requires_deposit ? 1 : 0,
        fulfillment_channel: m.fulfillment_channel,
        languages: JSON.stringify(m.languages),
        max_party_size: m.max_party_size,
        stamp,
      });
      already ? result.updated++ : result.inserted++;

      clearIngestProvenance.run(m.merchant_id, ...sourceKeys);
      for (const p of m.source_provenance) {
        insertProvenance.run(m.merchant_id, p.field, p.source, p.detail, p.recorded_at);
        result.provenance_rows++;
      }
    }
  })();

  return result;
}

// `website` and `timezone` from the release are not imported yet — the
// merchants table has no columns for them (schema-versioned ask parked with
// @eng); the data stays in the release artifacts and re-imports cleanly later.

function parseArgs(argv: string[]) {
  const args: { release?: string; db?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--release") args.release = argv[++i];
    else if (argv[i] === "--db") args.db = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!args.release) throw new Error("--release <dir> is required");
  return args;
}

if (process.argv[1] && process.argv[1].endsWith("import.ts")) {
  const args = parseArgs(process.argv.slice(2));
  const db = getDb(args.db ?? config.dbPath);
  importRelease(db, args.release!)
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
