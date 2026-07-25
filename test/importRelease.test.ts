import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestDb } from "../src/db/index.js";
import { CITIES } from "../src/ingest/cities.js";
import { validateRelease } from "../src/ingest/validate.js";
import { deriveBookable } from "../src/registry/merchants.js";
import { importRelease } from "../src/ingest/import.js";
import { nominateTranche } from "../src/ingest/tranche.js";
import { buildNaicsWhere, NAICS_PREFIXES } from "../src/ingest/connectors/losangeles.js";
import { FEHD_URLS } from "../src/ingest/connectors/fehd.js";
import { sha256Hex } from "../src/ingest/normalize.js";
import type { ReleaseManifest, ReleaseMerchant } from "../src/ingest/types.js";

function releaseMerchant(over: Partial<ReleaseMerchant> & { merchant_id: string; name: string }): ReleaseMerchant {
  return {
    aliases: [],
    category: "restaurant",
    cuisine_tags: ["cantonese"],
    attribute_tags: [],
    location: { address: "8 Finance St", neighborhood: "Central", city: "Hong Kong", lat: 22.281, lng: 114.158 },
    timezone: "Asia/Hong_Kong",
    phone_primary: "+85228204021",
    phone_verified_at: null,
    hours: [],
    holiday_exceptions: [],
    price_band: 2,
    reservation_policy: "accepts_reservations",
    requires_deposit: false,
    bookable: false,
    fulfillment_channel: "voice_agent",
    website: null,
    languages: [],
    verification_status: "unverified",
    opt_out: false,
    max_party_size: 8,
    source_provenance: [
      { field: "name", source: "overture", detail: "test (id: g-1)", recorded_at: "2026-07-16T00:00:00Z" },
    ],
    ...over,
  };
}

function writeRelease(merchants: ReleaseMerchant[], tamper = false, generatedAt = "2026-07-16"): string {
  const dir = mkdtempSync(join(tmpdir(), "import-"));
  const ndjson = merchants.map((m) => JSON.stringify(m)).join("\n") + "\n";
  const manifest: Partial<ReleaseManifest> = {
    release: "2026-07-16-hk",
    city: "Hong Kong",
    city_key: "hk",
    generated_at: generatedAt,
    merchant_count: merchants.length,
    sources: [
      { source: "overture", license: "CDLA-Permissive-2.0", detail: "test", records: merchants.length, retrieved_at: "2026-07-16T00:00:00Z" },
    ],
    checksum_sha256: sha256Hex(ndjson) + (tamper ? "0" : ""),
    ndjson_file: "merchants.ndjson",
  };
  writeFileSync(join(dir, "merchants.ndjson"), ndjson);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  return dir;
}

test("import: inserts merchants + provenance, records stay unverified and not bookable", async () => {
  const db = openTestDb();
  const dir = writeRelease([
    releaseMerchant({ merchant_id: "aaaaaaaa-0000-4000-8000-000000000001", name: "Lung King Heen" }),
    releaseMerchant({ merchant_id: "bbbbbbbb-0000-4000-8000-000000000002", name: "Mak's Noodle" }),
  ]);
  const result = await importRelease(db, dir);
  assert.equal(result.inserted, 2);
  assert.equal(result.updated, 0);
  assert.equal(result.provenance_rows, 2);

  const row = db.prepare("SELECT * FROM merchants WHERE merchant_id = ?").get("aaaaaaaa-0000-4000-8000-000000000001") as any;
  assert.equal(row.verification_status, "unverified");
  assert.equal(row.phone_verified_at, null);
  assert.equal(row.timezone, "Asia/Hong_Kong"); // per-merchant zone imported from the release
  assert.ok(!deriveBookable(row));
  const prov = db.prepare("SELECT * FROM provenance WHERE merchant_id = ?").all(row.merchant_id) as any[];
  assert.equal(prov.length, 1);
  assert.equal(prov[0].recorded_at, "2026-07-16T00:00:00Z");
});

test("import: re-import upserts without duplicating and preserves ops-owned fields", async () => {
  const db = openTestDb();
  const id = "aaaaaaaa-0000-4000-8000-000000000001";
  const dir = writeRelease([releaseMerchant({ merchant_id: id, name: "Lung King Heen" })]);
  await importRelease(db, dir);

  // ops actions between imports: verification + opt-out
  db.prepare("UPDATE merchants SET phone_verified_at = ?, verification_status = 'phone_verified', opt_out = 1 WHERE merchant_id = ?")
    .run("2026-07-17T00:00:00Z", id);
  db.prepare("INSERT INTO provenance (merchant_id, field, source, detail, recorded_at) VALUES (?, 'phone_primary', 'verification_call', 'call 42', ?)")
    .run(id, "2026-07-17T00:00:00Z");

  const dir2 = writeRelease([releaseMerchant({ merchant_id: id, name: "Lung King Heen", phone_primary: "+85299999999" })]);
  const result = await importRelease(db, dir2);
  assert.equal(result.inserted, 0);
  // the only source-side difference is the phone, and the verified phone is
  // preserved — so no served field changed; the disagreement becomes a signal
  assert.equal(result.updated, 0);
  assert.equal(result.unchanged, 1);
  assert.equal(result.phone_conflicts, 1);
  assert.equal(result.field_changes, 0); // a held-back phone is a conflict, not a served-field drift

  const row = db.prepare("SELECT * FROM merchants WHERE merchant_id = ?").get(id) as any;
  assert.equal(row.phone_verified_at, "2026-07-17T00:00:00Z"); // verification preserved
  assert.equal(row.opt_out, 1); // REQ-ING-4: opt-out survives re-import
  assert.equal(row.phone_primary, "+85228204021"); // verified phone NOT overwritten by source change
  assert.equal(row.source_phone_conflict, "+85299999999"); // …but the disagreement is recorded (REQ-ING-3)
  assert.equal(row.source_phone_conflict_at, "2026-07-16T00:00:00Z");
  const prov = db.prepare("SELECT source FROM provenance WHERE merchant_id = ? ORDER BY source").all(id) as any[];
  // ingestion provenance refreshed (1 row), verification_call row untouched
  assert.deepEqual(prov.map((p) => p.source), ["overture", "verification_call"]);
});

test("import: change-aware updated_at — unchanged re-imports don't touch record age", async () => {
  const db = openTestDb();
  const id = "aaaaaaaa-0000-4000-8000-000000000001";
  const dir = writeRelease([releaseMerchant({ merchant_id: id, name: "Lung King Heen" })]);
  await importRelease(db, dir);
  const stamped = (db.prepare("SELECT updated_at FROM merchants WHERE merchant_id = ?").get(id) as any).updated_at;

  // identical release re-imported: nothing served changed → updated_at stays
  const same = writeRelease([releaseMerchant({ merchant_id: id, name: "Lung King Heen" })]);
  const r2 = await importRelease(db, same);
  assert.equal(r2.updated, 0);
  assert.equal(r2.unchanged, 1);
  assert.equal(r2.phone_conflicts, 0);
  assert.equal((db.prepare("SELECT updated_at FROM merchants WHERE merchant_id = ?").get(id) as any).updated_at, stamped);

  // a real change bumps updated_at to the new release's stamp
  const changed = writeRelease([releaseMerchant({ merchant_id: id, name: "Lung King Heen", location: { address: "10 Finance St", neighborhood: "Central", city: "Hong Kong", lat: 22.281, lng: 114.158 } })]);
  const r3 = await importRelease(db, changed);
  assert.equal(r3.updated, 1);
  assert.equal(r3.unchanged, 0);
  const row = db.prepare("SELECT address, updated_at FROM merchants WHERE merchant_id = ?").get(id) as any;
  assert.equal(row.address, "10 Finance St");
  assert.equal(row.updated_at, "2026-07-16T00:00:00Z");
});

test("import: phone conflict clears when the source re-agrees; ledger records every import", async () => {
  const db = openTestDb();
  const id = "aaaaaaaa-0000-4000-8000-000000000001";
  await importRelease(db, writeRelease([releaseMerchant({ merchant_id: id, name: "Lung King Heen" })]));
  db.prepare("UPDATE merchants SET phone_verified_at = ?, verification_status = 'phone_verified' WHERE merchant_id = ?").run("2026-07-17T00:00:00Z", id);

  // source disagrees → conflict opens
  await importRelease(db, writeRelease([releaseMerchant({ merchant_id: id, name: "Lung King Heen", phone_primary: "+85299999999" })]));
  // source drops the phone entirely → not a new number, conflict stays open
  const dropped = await importRelease(db, writeRelease([releaseMerchant({ merchant_id: id, name: "Lung King Heen", phone_primary: null })]));
  assert.equal(dropped.phone_conflicts, 1);
  assert.equal((db.prepare("SELECT source_phone_conflict FROM merchants WHERE merchant_id = ?").get(id) as any).source_phone_conflict, "+85299999999");
  // source re-agrees with the verified phone → conflict clears
  const agreed = await importRelease(db, writeRelease([releaseMerchant({ merchant_id: id, name: "Lung King Heen" })]));
  assert.equal(agreed.phone_conflicts, 0);
  const row = db.prepare("SELECT source_phone_conflict, source_phone_conflict_at FROM merchants WHERE merchant_id = ?").get(id) as any;
  assert.equal(row.source_phone_conflict, null);
  assert.equal(row.source_phone_conflict_at, null);

  const ledger = db.prepare("SELECT * FROM imports ORDER BY id").all() as any[];
  assert.equal(ledger.length, 4);
  assert.equal(ledger[0].city_key, "hk");
  assert.equal(ledger[0].inserted, 1);
  assert.equal(ledger[1].phone_conflicts, 1);
  assert.equal(ledger[3].phone_conflicts, 0);
  assert.ok(JSON.parse(ledger[0].manifest_json).release);
});

test("import: verification queue pulls phone conflicts first (REQ-ING-3 change signal)", async () => {
  const { verificationQueue, recordVerification } = await import("../src/registry/merchants.js");
  const db = openTestDb();
  const conflicted = "aaaaaaaa-0000-4000-8000-000000000001";
  const neverVerified = "bbbbbbbb-0000-4000-8000-000000000002";
  await importRelease(db, writeRelease([
    releaseMerchant({ merchant_id: conflicted, name: "Lung King Heen" }),
    releaseMerchant({ merchant_id: neverVerified, name: "Mak's Noodle", phone_primary: "+85221234567" }),
  ]));
  // freshly verified (10 days ago — NOT in the queue on age alone), then a
  // release generated today carries a different phone: a post-verification
  // observation, so it pulls, ahead of everything else
  const verifiedAt = new Date(Date.now() - 10 * 86400_000).toISOString();
  db.prepare("UPDATE merchants SET phone_verified_at = ?, verification_status = 'phone_verified' WHERE merchant_id = ?").run(verifiedAt, conflicted);
  const today = new Date().toISOString().slice(0, 10);
  await importRelease(db, writeRelease([
    releaseMerchant({ merchant_id: conflicted, name: "Lung King Heen", phone_primary: "+85299999999" }),
    releaseMerchant({ merchant_id: neverVerified, name: "Mak's Noodle", phone_primary: "+85221234567" }),
  ], false, today));

  const queue = verificationQueue(db) as any[];
  assert.equal(queue[0].merchant_id, conflicted); // change signal outranks never-verified
  assert.equal(queue[0].source_phone_conflict, "+85299999999");
  assert.ok(queue.some((q) => q.merchant_id === neverVerified));

  // Operator re-verifies (confirms the number stands despite the source):
  // the still-open conflict predates the verification and must NOT keep the
  // merchant in the queue — a permanently disagreeing source would otherwise
  // occupy the front of the queue forever.
  recordVerification(db, conflicted, "ben", "verified");
  const requeued = verificationQueue(db) as any[];
  assert.ok(!requeued.some((q) => q.merchant_id === conflicted));
  // …but the disagreement itself is still recorded for meta honesty
  assert.equal((db.prepare("SELECT source_phone_conflict FROM merchants WHERE merchant_id = ?").get(conflicted) as any).source_phone_conflict, "+85299999999");
});

test("import: name/address/geo drift on a verified merchant is served but flagged until re-verified", async () => {
  const { verificationQueue, recordVerification, registryMeta } = await import("../src/registry/merchants.js");
  const db = openTestDb();
  const id = "aaaaaaaa-0000-4000-8000-000000000001";
  const plain = "bbbbbbbb-0000-4000-8000-000000000002";
  await importRelease(db, writeRelease([
    releaseMerchant({ merchant_id: id, name: "Lung King Heen" }),
    releaseMerchant({ merchant_id: plain, name: "Mak's Noodle", phone_primary: "+85221234567" }),
  ]));
  const verifiedAt = new Date(Date.now() - 10 * 86400_000).toISOString();
  db.prepare("UPDATE merchants SET phone_verified_at = ?, verification_status = 'phone_verified' WHERE merchant_id = ?").run(verifiedAt, id);

  // address changes (+ sub-150m geo drift, which is snapshot noise, not a move)
  const moved = releaseMerchant({
    merchant_id: id,
    name: "Lung King Heen",
    location: { address: "10 Finance St", neighborhood: "Central", city: "Hong Kong", lat: 22.2812, lng: 114.158 },
  });
  const r1 = await importRelease(db, writeRelease([
    moved,
    releaseMerchant({ merchant_id: plain, name: "Mak's Noodle", phone_primary: "+85221234567", location: { address: "77 Wellington St", neighborhood: "Central", city: "Hong Kong", lat: 22.281, lng: 114.158 } }),
  ]));
  assert.equal(r1.field_changes, 1); // the unverified merchant's change is NOT a signal
  let row = db.prepare("SELECT address, verified_field_change, verified_field_change_at FROM merchants WHERE merchant_id = ?").get(id) as any;
  assert.equal(row.address, "10 Finance St"); // source is authoritative — the change is served
  assert.deepEqual(JSON.parse(row.verified_field_change), ["address"]); // …and flagged (no "geo": drift < 150m)
  assert.equal(row.verified_field_change_at, "2026-07-16T00:00:00Z");
  assert.equal((db.prepare("SELECT verified_field_change FROM merchants WHERE merchant_id = ?").get(plain) as any).verified_field_change, null);

  // later: rename + a real move (>150m) — signal accumulates, first-observed stamp kept
  const renamed = releaseMerchant({
    merchant_id: id,
    name: "Lung King Heen II",
    location: { address: "10 Finance St", neighborhood: "Central", city: "Hong Kong", lat: 22.29, lng: 114.158 },
  });
  await importRelease(db, writeRelease([renamed], false, "2026-07-17"));
  row = db.prepare("SELECT verified_field_change, verified_field_change_at FROM merchants WHERE merchant_id = ?").get(id) as any;
  assert.deepEqual(JSON.parse(row.verified_field_change), ["address", "geo", "name"]);
  assert.equal(row.verified_field_change_at, "2026-07-16T00:00:00Z");

  // the open signal pulls into the verification queue despite fresh verification
  const queue = verificationQueue(db) as any[];
  assert.equal(queue[0].merchant_id, id);
  assert.equal((registryMeta(db) as any).data.verified_field_changes, 1);
  const ledger = db.prepare("SELECT field_changes FROM imports ORDER BY id").all() as any[];
  assert.deepEqual(ledger.map((l) => l.field_changes), [0, 1, 1]);

  // re-verification blesses the served values: signal clears, identical
  // re-import doesn't re-open it
  recordVerification(db, id, "ben", "verified");
  row = db.prepare("SELECT verified_field_change, verified_field_change_at FROM merchants WHERE merchant_id = ?").get(id) as any;
  assert.equal(row.verified_field_change, null);
  assert.equal(row.verified_field_change_at, null);
  const r3 = await importRelease(db, writeRelease([renamed], false, "2026-07-18"));
  assert.equal(r3.field_changes, 0);
  assert.ok(!(verificationQueue(db) as any[]).some((q) => q.merchant_id === id));
});

test("registry meta: data block serves release provenance, record age, and conflicts from the ledger", async () => {
  const { registryMeta } = await import("../src/registry/merchants.js");
  const db = openTestDb();
  const meta0 = registryMeta(db) as any;
  assert.deepEqual(meta0.data.releases, []); // honest emptiness pre-ledger
  assert.equal(meta0.data.record_age_days.p50, null);

  const id = "aaaaaaaa-0000-4000-8000-000000000001";
  await importRelease(db, writeRelease([releaseMerchant({ merchant_id: id, name: "Lung King Heen" })]));
  const meta = registryMeta(db) as any;
  assert.equal(meta.data.releases.length, 1);
  const rel = meta.data.releases[0];
  assert.equal(rel.city_key, "hk");
  assert.equal(rel.release, "2026-07-16-hk");
  assert.equal(rel.generated_at, "2026-07-16");
  assert.equal(rel.merchant_count, 1);
  assert.ok(rel.source_data_age_days >= 0);
  assert.equal(rel.churn_vs_previous_release, null); // fixture manifest has no diff block
  assert.ok(typeof meta.data.record_age_days.p50 === "number");
  assert.equal(meta.data.source_phone_conflicts, 0);
  assert.equal(meta.data.verified_field_changes, 0);
});

test("import: refuses checksum mismatch and verification claims", async () => {
  const db = openTestDb();
  const tampered = writeRelease([releaseMerchant({ merchant_id: "aaaaaaaa-0000-4000-8000-000000000001", name: "X" })], true);
  await assert.rejects(() => importRelease(db, tampered), /checksum mismatch/);

  const claiming = writeRelease([
    { ...releaseMerchant({ merchant_id: "bbbbbbbb-0000-4000-8000-000000000002", name: "Y" }), verification_status: "phone_verified" as any },
  ]);
  await assert.rejects(() => importRelease(db, claiming), /claims verification/);
});

test("tranche: phone required, official match ranks first, deterministic, honest criteria", () => {
  const manifest = { release: "2026-07-16-la", city: "Los Angeles, CA", ndjson_file: "merchants.ndjson" } as ReleaseManifest;
  const merchants = [
    releaseMerchant({ merchant_id: "cccccccc-0000-4000-8000-000000000003", name: "No Phone Cafe", phone_primary: null }),
    releaseMerchant({ merchant_id: "bbbbbbbb-0000-4000-8000-000000000002", name: "Plain Diner" }),
    releaseMerchant({
      merchant_id: "aaaaaaaa-0000-4000-8000-000000000001",
      name: "Registered Grill",
      website: "https://example.test",
      source_provenance: [
        { field: "name", source: "overture", detail: "t", recorded_at: "2026-07-16T00:00:00Z" },
        { field: "name", source: "la_open_data", detail: "t", recorded_at: "2026-07-16T00:00:00Z" },
      ],
    }),
  ];
  const packet = nominateTranche(manifest, merchants, { size: 10 });
  assert.equal(packet.candidate_count, 2); // phoneless excluded
  assert.equal(packet.candidates[0].name, "Registered Grill");
  assert.ok(packet.candidates[0].signals.includes("official_register_match"));
  assert.equal(packet.candidates[0].timezone, "Asia/Hong_Kong");
  assert.ok(packet.top_neighborhoods[0].candidates >= 1);

  const capped = nominateTranche(manifest, merchants, { size: 1 });
  assert.equal(capped.candidate_count, 1);
});

test("la connector: NAICS filter covers modern and legacy code families", () => {
  const where = buildNaicsWhere();
  for (const prefix of NAICS_PREFIXES) assert.ok(where.includes(`'${prefix}'`));
  assert.ok(where.includes(" OR "));
});

test("chain disambiguation: register address picks the right branch; no address stays ambiguous", async () => {
  const { addressesMatch } = await import("../src/ingest/normalize.js");
  assert.ok(addressesMatch("8 FINANCE STREET, CENTRAL", "8 Finance St"));
  assert.ok(!addressesMatch("SHOP 5 OCEAN TERMINAL", "8 Finance St"));
  assert.ok(!addressesMatch(null, "8 Finance St"));
  // shared street name but different number = different branch, no match
  assert.ok(!addressesMatch("120 Finance Street", "8 Finance St"));

  const { enrichWithOfficial: enrich } = await import("../src/ingest/conflate.js");
  const branch = (id: string, address: string) => ({
    ref: { source: "overture", source_id: id, detail: "t", retrieved_at: "2026-07-17T00:00:00Z" },
    name: "Tsui Wah",
    aliases: [] as string[],
    cuisine_tags: [] as string[],
    address,
    neighborhood: "",
    lat: 22.281,
    lng: 114.158,
    phone: null,
    website: null,
    confidence: 0.9,
    merged_refs: [{ source: "overture", source_id: id, detail: "t", retrieved_at: "2026-07-17T00:00:00Z" }],
    official: [] as any[],
    wikidata: [] as any[],
  });
  const a = branch("b-1", "15 Wellington St");
  const b = branch("b-2", "77 Canton Rd");
  const officialRec = (adr: string | null) => ({
    ref: { source: "fehd_hk", source_id: "L1", detail: "t", retrieved_at: "2026-07-17T00:00:00Z" },
    name: "TSUI WAH",
    name_local: "翠華餐廳",
    district: null,
    address: adr,
    lat: null,
    lng: null,
  });

  const resolved = enrich([a, b], [officialRec("15 WELLINGTON STREET, CENTRAL")]);
  assert.deepEqual(resolved, { matched: 1, ambiguous: 0, unmatched: 0 });
  assert.ok(a.aliases.includes("翠華餐廳"));
  assert.equal(b.official.length, 0);

  const c = branch("b-3", "15 Wellington St");
  const d = branch("b-4", "77 Canton Rd");
  const stillAmbiguous = enrich([c, d], [officialRec(null)]);
  assert.deepEqual(stillAmbiguous, { matched: 0, ambiguous: 1, unmatched: 0 });
});

test("coverage: local_name counts non-ASCII primaries that local_alias misses", () => {
  const merchants = [
    releaseMerchant({ merchant_id: "aaaaaaaa-0000-4000-8000-000000000001", name: "寿司大" }), // ja primary, no alias
    releaseMerchant({ merchant_id: "bbbbbbbb-0000-4000-8000-000000000002", name: "Lung King Heen", aliases: ["龍景軒"] }),
    releaseMerchant({ merchant_id: "cccccccc-0000-4000-8000-000000000003", name: "Plain Diner" }),
  ];
  const HK_CITY = CITIES.hk;
  const report = validateRelease(HK_CITY, merchants);
  assert.equal(report.field_coverage.local_alias, Math.round((1 / 3) * 1000) / 1000);
  assert.equal(report.field_coverage.local_name, Math.round((2 / 3) * 1000) / 1000);
});

test("qa: deterministic sampling, well-formedness gate, register evidence", async () => {
  const { runQa, sampleMerchants } = await import("../src/ingest/qa.js");

  const many = Array.from({ length: 200 }, (_, i) =>
    releaseMerchant({ merchant_id: `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`, name: `Place ${i}` }),
  );
  const s1 = sampleMerchants(many, 50, "deadbeef00");
  const s2 = sampleMerchants(many, 50, "deadbeef00");
  assert.equal(s1.length, 50);
  assert.deepEqual(s1.map((m) => m.merchant_id), s2.map((m) => m.merchant_id)); // reproducible
  assert.notEqual(sampleMerchants(many, 50, "00000001ff")[0].merchant_id, undefined);

  const good = releaseMerchant({
    merchant_id: "aaaaaaaa-0000-4000-8000-000000000001",
    name: "Lung King Heen",
    source_provenance: [
      { field: "name", source: "overture", detail: "t", recorded_at: "2026-07-17T00:00:00Z" },
      { field: "name", source: "fehd_hk", detail: "t", recorded_at: "2026-07-17T00:00:00Z" },
    ],
  });
  const cjkAddr = releaseMerchant({
    merchant_id: "bbbbbbbb-0000-4000-8000-000000000002",
    name: "青山灣美食廚房",
    location: { address: "豐漁樓", neighborhood: "New Territories", city: "Hong Kong", lat: 22.4, lng: 114.0 },
  });
  const bad = releaseMerchant({
    merchant_id: "cccccccc-0000-4000-8000-000000000003",
    name: "Broken Row",
    location: { address: "", neighborhood: "", city: "Hong Kong", lat: 22.3, lng: 114.2 },
  });

  const passDir = writeRelease([good, cjkAddr]);
  const passRun = await runQa(passDir, { sample: 50, probeWebsites: false });
  assert.equal(passRun.report.verdict, "pass");
  assert.equal(passRun.report.gate.well_formedness_failures.length, 0);
  assert.equal(passRun.report.evidence.register_confirmed, 1);
  assert.equal(passRun.report.evidence.website_live_rate, null); // no probes → no claim

  const failDir = writeRelease([good, bad]);
  const failRun = await runQa(failDir, { sample: 50, probeWebsites: false });
  assert.equal(failRun.report.verdict, "fail");
  assert.equal(failRun.report.gate.well_formedness_failures[0].reason, "address empty");
});

test("fehd: ZH feed primary candidate is the data.gov.hk TC resource", () => {
  assert.ok(FEHD_URLS.zh[0].includes("/tc_chi/"));
  assert.ok(FEHD_URLS.zh[0].endsWith("LP_Restaurants_TC.XML"));
  assert.ok(FEHD_URLS.zh.length >= 2);
});

test("website: imported from the release, served on the full record, kept out of search", async () => {
  const { getMerchant, searchMerchants } = await import("../src/registry/merchants.js");
  const db = openTestDb();
  const withSite = "aaaaaaaa-0000-4000-8000-000000000010";
  const noSite = "aaaaaaaa-0000-4000-8000-000000000011";
  await importRelease(db, writeRelease([
    releaseMerchant({ merchant_id: withSite, name: "Lung King Heen", website: "https://lungkingheen.example" }),
    releaseMerchant({ merchant_id: noSite, name: "Mak's Noodle", location: { address: "77 Wellington St", neighborhood: "Central", city: "Hong Kong", lat: 22.2811, lng: 114.1581 } }),
  ]));

  // the release value lands in the column and on the full record…
  assert.equal(
    (db.prepare("SELECT website FROM merchants WHERE merchant_id = ?").get(withSite) as any).website,
    "https://lungkingheen.example",
  );
  assert.equal(getMerchant(db, withSite)!.website, "https://lungkingheen.example");
  // …and absent stays absent — never fabricated, never defaulted to a string
  assert.equal(getMerchant(db, noSite)!.website, null);

  // search stays compact (agent-readability principle 1): website is get_merchant-only
  const hit = searchMerchants(db, { limit: 10 } as any).results.find((r) => r.merchant_id === withSite)!;
  assert.equal("website" in hit, false);
});

test("website drift on a verified merchant is affirmative-only (replacement flags; fill and drop don't)", async () => {
  const { recordVerification } = await import("../src/registry/merchants.js");
  const db = openTestDb();
  const id = "aaaaaaaa-0000-4000-8000-000000000012";
  await importRelease(db, writeRelease([releaseMerchant({ merchant_id: id, name: "Lung King Heen", website: null })]));
  const verifiedAt = new Date(Date.now() - 10 * 86400_000).toISOString();
  db.prepare("UPDATE merchants SET phone_verified_at = ?, verification_status = 'phone_verified' WHERE merchant_id = ?").run(verifiedAt, id);

  const site = (w: string | null) => releaseMerchant({ merchant_id: id, name: "Lung King Heen", website: w });
  const readRow = () =>
    db.prepare("SELECT website, verified_field_change FROM merchants WHERE merchant_id = ?").get(id) as any;

  // null → value: a source first supplying a URL is enrichment, not drift
  await importRelease(db, writeRelease([site("https://a.example")], false, "2026-07-17"));
  assert.equal(readRow().website, "https://a.example");
  assert.equal(readRow().verified_field_change, null);

  // identical re-import: no change at all
  const r = await importRelease(db, writeRelease([site("https://a.example")], false, "2026-07-18"));
  assert.equal(r.unchanged, 1);
  assert.equal(readRow().verified_field_change, null);

  // value → null: the source dropped it — served (the release stays the truth),
  // but a snapshot gap says nothing about the venue, so it is not a signal
  await importRelease(db, writeRelease([site(null)], false, "2026-07-19"));
  assert.equal(readRow().website, null);
  assert.equal(readRow().verified_field_change, null);

  // value → different value: a rebrand/change-of-hands signal — flagged
  await importRelease(db, writeRelease([site("https://b.example")], false, "2026-07-20"));
  assert.equal(readRow().website, "https://b.example");
  assert.equal(readRow().verified_field_change, null); // prev was null (dropped above), so still a fill
  await importRelease(db, writeRelease([site("https://c.example")], false, "2026-07-21"));
  assert.deepEqual(JSON.parse(readRow().verified_field_change), ["website"]);

  // re-verification blesses the served value and clears the signal
  recordVerification(db, id, "ben", "verified");
  assert.equal(readRow().verified_field_change, null);

  // an unverified merchant never accumulates the signal
  const plain = "aaaaaaaa-0000-4000-8000-000000000013";
  await importRelease(db, writeRelease([releaseMerchant({ merchant_id: plain, name: "Mak's Noodle", website: "https://x.example" })], false, "2026-07-22"));
  await importRelease(db, writeRelease([releaseMerchant({ merchant_id: plain, name: "Mak's Noodle", website: "https://y.example" })], false, "2026-07-23"));
  assert.equal((db.prepare("SELECT verified_field_change FROM merchants WHERE merchant_id = ?").get(plain) as any).verified_field_change, null);
});
