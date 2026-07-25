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
import { haversineKm, sha256Hex } from "./normalize.js";
import type { ReleaseManifest, ReleaseMerchant } from "./types.js";

export interface ImportResult {
  city: string;
  release: string;
  inserted: number;
  /** Rows whose served fields actually changed (updated_at bumps only for these). */
  updated: number;
  /** Rows the release carried with no served-field change (updated_at untouched). */
  unchanged: number;
  /** Verified merchants whose source phone disagrees with the verified phone (open after this import). */
  phone_conflicts: number;
  /** Verified merchants with an open name/address/geo change signal after this import. */
  field_changes: number;
  provenance_rows: number;
}

/** A geo move below this is Overture snapshot drift, not a venue move. */
const GEO_CHANGE_KM = 0.15;

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

  // Change-aware import (P2 freshness): updated_at bumps ONLY when a served
  // field actually changed, so record age is a real staleness measure instead
  // of "when did the last import run". Rows are compared in JS against the
  // exact values we would write.
  const existing = db.prepare(`
    SELECT name, aliases, cuisine_tags, address, neighborhood, city, timezone, lat, lng,
           website, phone_primary, phone_verified_at, source_phone_conflict, source_phone_conflict_at,
           verified_field_change, verified_field_change_at
    FROM merchants WHERE merchant_id = ?
  `);
  const insert = db.prepare(`
    INSERT INTO merchants (
      merchant_id, name, aliases, category, cuisine_tags, attribute_tags,
      address, neighborhood, city, timezone, lat, lng, website, phone_primary, phone_verified_at,
      hours, holiday_exceptions, price_band, reservation_policy, requires_deposit,
      fulfillment_channel, languages, verification_status, opt_out,
      max_party_size, created_at, updated_at
    ) VALUES (
      @merchant_id, @name, @aliases, @category, @cuisine_tags, @attribute_tags,
      @address, @neighborhood, @city, @timezone, @lat, @lng, @website, @phone_primary, NULL,
      @hours, @holiday_exceptions, @price_band, @reservation_policy, @requires_deposit,
      @fulfillment_channel, @languages, 'unverified', 0,
      @max_party_size, @stamp, @stamp
    )
  `);
  const update = db.prepare(`
    UPDATE merchants SET
      name = @name, aliases = @aliases, cuisine_tags = @cuisine_tags,
      address = @address, neighborhood = @neighborhood, city = @city, timezone = @timezone,
      lat = @lat, lng = @lng, website = @website, phone_primary = @phone_primary,
      source_phone_conflict = @source_phone_conflict, source_phone_conflict_at = @source_phone_conflict_at,
      verified_field_change = @verified_field_change, verified_field_change_at = @verified_field_change_at,
      updated_at = @updated_at
    WHERE merchant_id = @merchant_id
    -- ops/verification-owned columns deliberately absent from the update list:
    -- phone_verified_at, verification_status, opt_out, opt_out_at, annoyance_count,
    -- human_call_flag_reason, attribute_tags, hours, reservation_policy,
    -- price_band, languages, max_party_size (release values for these are
    -- unsourced defaults or absent — they must not clobber verified data)
  `);
  const touchConflict = db.prepare(
    "UPDATE merchants SET source_phone_conflict = ?, source_phone_conflict_at = ? WHERE merchant_id = ?",
  );
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
    unchanged: 0,
    phone_conflicts: 0,
    field_changes: 0,
    provenance_rows: 0,
  };

  interface ExistingRow {
    name: string;
    aliases: string;
    cuisine_tags: string;
    address: string;
    neighborhood: string;
    city: string;
    timezone: string | null;
    lat: number;
    lng: number;
    website: string | null;
    phone_primary: string | null;
    phone_verified_at: string | null;
    source_phone_conflict: string | null;
    source_phone_conflict_at: string | null;
    verified_field_change: string | null;
    verified_field_change_at: string | null;
  }

  db.transaction(() => {
    for (const m of merchants) {
      const prev = existing.get(m.merchant_id) as ExistingRow | undefined;
      if (!prev) {
        insert.run({
          merchant_id: m.merchant_id,
          name: m.name,
          aliases: JSON.stringify(m.aliases),
          category: m.category,
          cuisine_tags: JSON.stringify(m.cuisine_tags),
          attribute_tags: JSON.stringify(m.attribute_tags),
          address: m.location.address,
          neighborhood: m.location.neighborhood,
          city: m.location.city,
          timezone: m.timezone ?? null,
          lat: m.location.lat,
          lng: m.location.lng,
          website: m.website ?? null,
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
        result.inserted++;
      } else {
        // A verified phone is never replaced by a source phone: that would
        // break the phone_verified_at pairing. A disagreeing source phone
        // becomes a re-verification signal instead (REQ-ING-3); it clears when
        // the source re-agrees. A source that DROPS the phone (null) is not a
        // new number — the open conflict, if any, is preserved.
        const verified = prev.phone_verified_at !== null;
        const phone = verified ? prev.phone_primary : m.phone_primary;
        let conflict = verified ? prev.source_phone_conflict : null;
        if (verified && m.phone_primary !== null) {
          conflict = m.phone_primary === prev.phone_primary ? null : m.phone_primary;
        }
        const conflictAt =
          conflict === null ? null : conflict === prev.source_phone_conflict ? prev.source_phone_conflict_at : stamp;
        if (conflict !== null) result.phone_conflicts++;

        // Name/address/geo drift on a verified merchant: the source is
        // authoritative for these (unlike phone), so the new value IS served —
        // but the venue may have moved, rebranded, or changed hands since the
        // operator verified it, so the change is flagged for re-verification
        // (REQ-ING-3). The signal accumulates across imports (first-observed
        // timestamp kept) and clears only when the operator re-verifies. A geo
        // move under GEO_CHANGE_KM is snapshot drift, not a signal.
        const drifted: string[] = [];
        if (verified) {
          if (m.name !== prev.name) drifted.push("name");
          if (m.location.address !== prev.address) drifted.push("address");
          if (haversineKm(m.location.lat, m.location.lng, prev.lat, prev.lng) > GEO_CHANGE_KM) drifted.push("geo");
          // Website drift is affirmative-only: a *replacement* (one live URL for
          // a different one) is evidence of a rebrand or change of hands, so it
          // flags. A source first supplying a URL (null → value) is enrichment,
          // and a source dropping one (value → null) is a gap in that snapshot,
          // not evidence about the venue — neither is a re-verification signal.
          // Sources disagree on website often (dedupe agreement 0.535, run #32),
          // so the conservative rule keeps the operator queue meaningful.
          const site = m.website ?? null;
          if (site !== null && prev.website !== null && site !== prev.website) drifted.push("website");
        }
        const openChanges = new Set<string>(prev.verified_field_change ? JSON.parse(prev.verified_field_change) : []);
        for (const f of drifted) openChanges.add(f);
        const fieldChange = openChanges.size ? JSON.stringify([...openChanges].sort()) : null;
        const fieldChangeAt = fieldChange === null ? null : (prev.verified_field_change_at ?? stamp);
        if (fieldChange !== null) result.field_changes++;

        const next = {
          name: m.name,
          aliases: JSON.stringify(m.aliases),
          cuisine_tags: JSON.stringify(m.cuisine_tags),
          address: m.location.address,
          neighborhood: m.location.neighborhood,
          city: m.location.city,
          timezone: m.timezone ?? null,
          lat: m.location.lat,
          lng: m.location.lng,
          website: m.website ?? null,
          phone_primary: phone,
        };
        const servedChange = (Object.keys(next) as (keyof typeof next)[]).some((k) => next[k] !== prev[k]);
        if (servedChange) {
          update.run({
            merchant_id: m.merchant_id,
            ...next,
            source_phone_conflict: conflict,
            source_phone_conflict_at: conflictAt,
            verified_field_change: fieldChange,
            verified_field_change_at: fieldChangeAt,
            updated_at: stamp,
          });
          result.updated++;
        } else {
          if (conflict !== prev.source_phone_conflict || conflictAt !== prev.source_phone_conflict_at) {
            touchConflict.run(conflict, conflictAt, m.merchant_id);
          }
          result.unchanged++;
        }
      }

      clearIngestProvenance.run(m.merchant_id, ...sourceKeys);
      for (const p of m.source_provenance) {
        insertProvenance.run(m.merchant_id, p.field, p.source, p.detail, p.recorded_at);
        result.provenance_rows++;
      }
    }

    // Import ledger (P2 freshness): the latest row per city is what
    // get_registry_meta serves as data provenance/staleness; history stays as
    // the audit trail. Full manifest travels along (coverage, diff, agreement).
    db.prepare(
      `INSERT INTO imports (city_key, city, release, generated_at, imported_at, checksum_sha256,
                            merchant_count, inserted, updated, unchanged, phone_conflicts, field_changes, manifest_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      manifest.city_key,
      manifest.city,
      manifest.release,
      manifest.generated_at,
      new Date().toISOString(),
      manifest.checksum_sha256,
      manifest.merchant_count,
      result.inserted,
      result.updated,
      result.unchanged,
      result.phone_conflicts,
      result.field_changes,
      JSON.stringify(manifest),
    );
  })();

  return result;
}

// `website` and `timezone` are both imported: timezone because naive booking
// datetimes and the call-window policy are merchant-local, website because it
// is the one release-carried contact field an agent can act on without a call.

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
