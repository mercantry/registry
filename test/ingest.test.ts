import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CITIES } from "../src/ingest/cities.js";
import { namesMatch, stableMerchantId, toE164 } from "../src/ingest/normalize.js";
import { parseOvertureFeatureLine, type OvertureDropCounts } from "../src/ingest/connectors/overture.js";
import { parseFehdXml } from "../src/ingest/connectors/fehd.js";
import { parseSocrataRows } from "../src/ingest/connectors/losangeles.js";
import { dedupeStaged, enrichWithOfficial, toReleaseMerchants } from "../src/ingest/conflate.js";
import { validateRelease } from "../src/ingest/validate.js";
import { writeRelease } from "../src/ingest/release.js";

const HK = CITIES.hk;
const STAMP = "2026-07-16T00:00:00Z";

const freshDrops = (): OvertureDropCounts => ({ non_restaurant: 0, unnamed: 0, no_geometry: 0, out_of_bbox: 0, no_address: 0, invalid_phone: 0 });

function overtureLine(over: Record<string, unknown>): string {
  return JSON.stringify({
    type: "Feature",
    geometry: { type: "Point", coordinates: [114.158, 22.281] },
    properties: {
      id: "gers-1",
      names: { primary: "Lung King Heen", common: { zh: "龍景軒" } },
      categories: { primary: "cantonese_restaurant", alternate: ["restaurant"] },
      confidence: 0.95,
      phones: ["+852 2820 4021"],
      websites: ["https://example.test/lkh"],
      addresses: [{ freeform: "8 Finance St", locality: "Central" }],
      ...over,
    },
    ...(typeof over.geometry === "object" ? { geometry: over.geometry } : {}),
  });
}

test("overture parser: keeps restaurants, maps fields, drops the rest with counts", () => {
  const drops = freshDrops();
  const place = parseOvertureFeatureLine(overtureLine({}), HK, STAMP, drops);
  assert.ok(place);
  assert.equal(place.name, "Lung King Heen");
  assert.deepEqual(place.aliases, ["龍景軒"]);
  assert.deepEqual(place.cuisine_tags, ["cantonese"]);
  assert.equal(place.phone, "+85228204021");
  assert.equal(place.neighborhood, "Central");
  assert.equal(place.ref.source, "overture");

  assert.equal(parseOvertureFeatureLine(overtureLine({ categories: { primary: "hotel" } }), HK, STAMP, drops), null);
  assert.equal(parseOvertureFeatureLine(overtureLine({ names: {} }), HK, STAMP, drops), null);
  assert.equal(
    parseOvertureFeatureLine(
      JSON.stringify({ type: "Feature", geometry: { type: "Point", coordinates: [139.7, 35.68] }, properties: { names: { primary: "Wrong City" }, categories: { primary: "restaurant" } } }),
      HK, STAMP, drops,
    ),
    null,
  );
  assert.equal(
    parseOvertureFeatureLine(
      JSON.stringify({ type: "Feature", properties: { names: { primary: "No Geometry" }, categories: { primary: "restaurant" } } }),
      HK, STAMP, drops,
    ),
    null,
  );
  // Runs #6/#7 QA findings: unlocatable addresses fail the served-corpus bar —
  // empty, whitespace, or street-only Latin ("Cameron Rd"). CJK addresses are
  // legitimately numberless (mall/building names) and stay.
  assert.equal(parseOvertureFeatureLine(overtureLine({ addresses: [] }), HK, STAMP, drops), null);
  assert.equal(parseOvertureFeatureLine(overtureLine({ addresses: [{ freeform: "   " }] }), HK, STAMP, drops), null);
  assert.equal(parseOvertureFeatureLine(overtureLine({ addresses: [{ freeform: "Cameron Rd" }] }), HK, STAMP, drops), null);
  assert.ok(parseOvertureFeatureLine(overtureLine({ addresses: [{ freeform: "鳳德商場" }] }), HK, STAMP, drops));
  assert.deepEqual(drops, { non_restaurant: 1, unnamed: 1, no_geometry: 1, out_of_bbox: 1, no_address: 3, invalid_phone: 0 });
});

test("phone normalization per country; bad numbers become null, never garbage", () => {
  assert.equal(toE164("(213) 555-0142", "US"), "+12135550142");
  assert.equal(toE164("1-213-555-0142", "US"), "+12135550142");
  assert.equal(toE164("03-1234-5678", "JP"), "+81312345678");
  assert.equal(toE164("+81 3 1234 5678", "JP"), "+81312345678");
  assert.equal(toE164("2820 4021", "HK"), "+85228204021");
  assert.equal(toE164("+852 2820 4021", "HK"), "+85228204021");
  assert.equal(toE164("12345", "US"), null);
  assert.equal(toE164("not a phone", "HK"), null);
  assert.equal(toE164(null, "JP"), null);
});

test("name matching: normalization, containment (CJK), token overlap", () => {
  assert.ok(namesMatch("LUNG KING HEEN", "Lung King Heen"));
  assert.ok(namesMatch("Ozumo Restaurant & Bar", "Ozumo Restaurant"));
  assert.ok(namesMatch("龍景軒", "龍景軒 (四季酒店)"));
  assert.ok(!namesMatch("Golden Palace", "Jade Garden"));
});

test("dedupe merges same-name places within 150m and backfills fields", () => {
  const drops = freshDrops();
  const a = parseOvertureFeatureLine(overtureLine({ phones: [] }), HK, STAMP, drops)!;
  const b = parseOvertureFeatureLine(
    overtureLine({
      id: "gers-2",
      confidence: 0.6,
      geometry: { type: "Point", coordinates: [114.1585, 22.2812] },
      names: { primary: "LUNG KING HEEN" },
      phones: ["2820 4021"],
    }).replace('"coordinates":[114.158,22.281]', '"coordinates":[114.1585,22.2812]'),
    HK, STAMP, drops,
  )!;
  const far = parseOvertureFeatureLine(
    overtureLine({ id: "gers-3", names: { primary: "Lung King Heen" } }).replace(
      '"coordinates":[114.158,22.281]',
      '"coordinates":[114.19,22.30]',
    ),
    HK, STAMP, drops,
  )!;

  const conflated = dedupeStaged([a, b, far]);
  assert.equal(conflated.length, 2);
  const merged = conflated.find((p) => p.merged_refs.length === 2)!;
  assert.ok(merged);
  assert.equal(merged.phone, "+85228204021"); // backfilled from the duplicate
  assert.equal(merged.confidence, 0.95); // higher-confidence record won
});

test("provenance rows keep each merged ref's own retrieval time", () => {
  const drops = freshDrops();
  const t1 = "2026-07-10T00:00:00Z";
  const t2 = "2026-07-16T00:00:00Z";
  const a = parseOvertureFeatureLine(overtureLine({}), HK, t1, drops)!;
  const b = parseOvertureFeatureLine(
    overtureLine({ id: "gers-b", confidence: 0.5, names: { primary: "LUNG KING HEEN" } }),
    HK, t2, drops,
  )!;
  const merchants = toReleaseMerchants(HK, dedupeStaged([a, b]));
  const prov = merchants[0].source_provenance;
  assert.ok(prov.some((p) => p.detail.includes("id: gers-1") && p.recorded_at === t1));
  assert.ok(prov.some((p) => p.detail.includes("id: gers-b") && p.recorded_at === t2));
  assert.ok(!prov.some((p) => p.detail.includes("id: gers-b") && p.recorded_at === t1));
});

const FEHD_EN = `<?xml version="1.0" encoding="UTF-8"?>
<LPS>
<LP><TYPE>General Restaurant</TYPE><DIST>CENTRAL &amp; WESTERN</DIST><LICNO>2231800123</LICNO><SS>LUNG KING HEEN</SS><ADR>8 FINANCE STREET, CENTRAL</ADR></LP>
<LP><TYPE>General Restaurant</TYPE><DIST>WAN CHAI</DIST><LICNO>2231800456</LICNO><SS>NOWHERE KITCHEN</SS><ADR>1 NOWHERE ROAD</ADR></LP>
</LPS>`;
const FEHD_ZH = `<?xml version="1.0" encoding="UTF-8"?>
<LPS>
<LP><DIST>中西區</DIST><LICNO>2231800123</LICNO><SS>龍景軒</SS></LP>
</LPS>`;

test("block-address canonicalization: cross-format matches without loose-digit false positives", async () => {
  const { addressesMatch, addressTokens } = await import("../src/ingest/normalize.js");

  // The cross-script case this exists for: kanji vs romanized, same block.
  assert.ok(addressesMatch("東京都新宿区西新宿6丁目6-2", "6 Chome-6-2 Nishishinjuku"));
  // 番/号 long form vs dash form; full-width digits + katakana chōonpu dash fold.
  assert.ok(addressesMatch("1丁目1番5号 狛江市役所内", "狛江 1丁目1-5"));
  assert.ok(addressesMatch("西新宿６丁目６ー２", "6 Chome-6-2 Nishishinjuku"));
  // Different blocks sharing loose digits must NOT match (the naive-split trap).
  assert.ok(!addressesMatch("東京都新宿区西新宿3丁目6-2", "東京都中野区中野6丁目2-9"));
  // Two-part blocks are too weak to stand alone across scripts.
  assert.ok(!addressesMatch("西新宿6丁目6", "6 Chome-6 Somewhere Else Entirely"));
  // Same-format two-part still matches via the classic >=2-shared+numeric rule.
  assert.ok(addressesMatch("中野区中野5丁目3", "中野区中野5丁目3"));
  // Block token is emitted alongside, not instead of, the existing tokens.
  const tokens = addressTokens("西新宿6丁目6-2");
  assert.ok(tokens.has("c6-6-2"));
  // Latin-address behavior unchanged.
  assert.ok(addressesMatch("8 FINANCE STREET, CENTRAL", "8 Finance St"));
  assert.ok(!addressesMatch("120 Finance Street", "8 Finance St"));
});

test("tokyo connector: CKAN selection, ledger CSV parsing, type filter, loud skips", async () => {
  const { selectLicenceResources, parseTokyoLicenceCsv, decodeCsvBuffer } = await import(
    "../src/ingest/connectors/tokyo.js"
  );

  // CKAN package_search filtering: licence ledgers in, statistics out, CSV only, deduped.
  const ckan = {
    result: {
      results: [
        {
          title: "食品営業許可一覧",
          organization: { title: "新宿区" },
          resources: [
            { url: "https://x.test/shinjuku.csv", format: "CSV", name: "令和8年6月" },
            { url: "https://x.test/shinjuku.pdf", format: "PDF" },
          ],
        },
        { title: "東京都統計年鑑", organization: { title: "東京都" }, resources: [{ url: "https://x.test/stats.csv", format: "CSV" }] },
        {
          title: "食品関係営業台帳",
          organization: { title: "東京都保健医療局" },
          resources: [{ url: "https://x.test/tama.csv", format: "csv" }],
        },
      ],
    },
  };
  const seen = new Set<string>();
  const resources = selectLicenceResources(ckan, seen);
  assert.deepEqual(resources.map((r) => r.url), ["https://x.test/shinjuku.csv", "https://x.test/tama.csv"]);
  assert.ok(resources[0].label.includes("新宿区"));
  assert.equal(selectLicenceResources(ckan, seen).length, 0); // dedupe across queries

  // Ledger CSV: standard headers, type filter, quoted fields, ward district from the label.
  const csv =
    '許可番号,営業所名称,営業所所在地,業種\n' +
    '30保健第123号,"寿司処 まぐろ,や",東京都新宿区西新宿6丁目6-2,飲食店営業\n' +
    "30保健第124号,パン工房アン,東京都新宿区北新宿1丁目1-1,菓子製造業\n" +
    "30保健第125号,喫茶ポエム,東京都新宿区高田馬場2丁目2-2,喫茶店営業\n";
  const parsed = parseTokyoLicenceCsv(csv, "新宿区 食品営業許可一覧", "2026-07-22T00:00:00Z");
  assert.equal(parsed.skippedReason, null);
  assert.equal(parsed.records.length, 2); // bakery filtered
  assert.equal(parsed.rowsFilteredByType, 1);
  assert.equal(parsed.records[0].name, "寿司処 まぐろ,や"); // quoted comma survived
  assert.equal(parsed.records[0].district, "新宿区");
  assert.equal(parsed.records[0].ref.source_id, "30保健第123号");
  assert.equal(parsed.records[1].name, "喫茶ポエム");

  // Variant headers map; missing name/address headers skip loudly, never guess.
  const variant = parseTokyoLicenceCsv("屋号,所在地\nそば処 やぶ,豊島区南池袋1-1-1\n", "豊島区 食品等営業許可・届出一覧", "2026-07-22T00:00:00Z");
  assert.equal(variant.records.length, 1);
  const unmapped = parseTokyoLicenceCsv("id,value\n1,2\n", "どこか", "2026-07-22T00:00:00Z");
  assert.equal(unmapped.records.length, 0);
  assert.ok(unmapped.skippedReason?.includes("unmapped headers"));

  // Run-#10 finding: wards publish the municipal-standard schema — 施設名称 +
  // 所在地_連結表記 must map, with 営業の種類 as the type column.
  const standard =
    "全国地方公共団体コード,ID,地方公共団体名,施設名称,施設名称_カナ,施設名称_英字,営業の種類,業態,所在地_連結表記\n" +
    "131032,1,港区,鮨 はまだ,スシ ハマダ,Sushi Hamada,飲食店営業,すし屋,東京都港区新橋2丁目1-1\n" +
    "131032,2,港区,青空青果店,アオゾラセイカテン,Aozora,野菜果物販売業,八百屋,東京都港区新橋3丁目3-3\n";
  const std = parseTokyoLicenceCsv(standard, "港区 食品営業許可一覧", "2026-07-22T00:00:00Z");
  assert.equal(std.skippedReason, null);
  assert.equal(std.records.length, 1); // greengrocer filtered by 営業の種類
  assert.equal(std.records[0].name, "鮨 はまだ");
  assert.equal(std.records[0].address, "東京都港区新橋2丁目1-1");
  assert.equal(std.records[0].district, "港区");

  // Encoding: UTF-8 with BOM passes through; BOM stripped so the first header maps.
  const utf8bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("許可番号,営業所名称,営業所所在地\n1,店,住所1-1\n")]);
  const decoded = decodeCsvBuffer(utf8bom.buffer);
  assert.ok(decoded.startsWith("許可番号"));
  assert.equal(parseTokyoLicenceCsv(decoded, "テスト区", "2026-07-22T00:00:00Z").records.length, 1);

  // Run-#10 finding: 新宿区 publishes UTF-16LE — BOM'd and BOM-less both decode.
  const text16 = "許可番号,営業所名称,営業所所在地\n2,新宿の店,西新宿6丁目6-2\n";
  const codes = [...text16].map((ch) => ch.codePointAt(0)!);
  const le = new Uint8Array(2 + codes.length * 2);
  le[0] = 0xff; le[1] = 0xfe;
  codes.forEach((c, i) => { le[2 + i * 2] = c & 0xff; le[3 + i * 2] = c >> 8; });
  assert.ok(decodeCsvBuffer(le.buffer).startsWith("許可番号"));
  const leNoBom = le.slice(2);
  assert.equal(parseTokyoLicenceCsv(decodeCsvBuffer(leNoBom.buffer), "新宿区", "2026-07-22T00:00:00Z").records.length, 1);
});

test("fehd parser joins EN/ZH on licence number; fails loudly on schema drift", () => {
  const records = parseFehdXml(FEHD_EN, FEHD_ZH, STAMP);
  assert.equal(records.length, 2);
  assert.equal(records[0].name, "LUNG KING HEEN");
  assert.equal(records[0].name_local, "龍景軒");
  assert.equal(records[0].district, "CENTRAL & WESTERN");
  assert.equal(records[0].ref.source_id, "2231800123");
  assert.throws(() => parseFehdXml("<html>maintenance page</html>", null, STAMP), /no records parsed/);
});

test("official enrichment: unique match adds local alias + provenance, ambiguous skipped", () => {
  const drops = freshDrops();
  const base = parseOvertureFeatureLine(overtureLine({ names: { primary: "Lung King Heen" } }), HK, STAMP, drops)!;
  base.aliases = [];
  const conflated = dedupeStaged([base]);
  const official = parseFehdXml(FEHD_EN, FEHD_ZH, STAMP);

  const stats = enrichWithOfficial(conflated, official);
  assert.deepEqual(stats, { matched: 1, ambiguous: 0, unmatched: 1 });
  assert.ok(conflated[0].aliases.includes("龍景軒"));

  const merchants = toReleaseMerchants(HK, conflated);
  const prov = merchants[0].source_provenance;
  assert.ok(prov.some((p) => p.source === "fehd_hk" && p.field === "name"));
  assert.ok(prov.some((p) => p.source === "fehd_hk" && p.field === "aliases"));
  assert.ok(prov.some((p) => p.source === "overture" && p.field === "location"));
});

test("la open data parser keeps LA-proper rows and maps geo", () => {
  const rows = [
    {
      location_account: "0000000123-0001-2",
      business_name: "SUNSET PIZZA CO",
      dba_name: "JOE'S PIZZA",
      street_address: "123 MAIN ST",
      city: "LOS ANGELES",
      location_1: { latitude: "34.05", longitude: "-118.25" },
      naics: "722511",
    },
    { business_name: "VALLEY CAFE", city: "BURBANK", naics: "722511" },
  ];
  const records = parseSocrataRows(rows, STAMP);
  assert.equal(records.length, 1);
  assert.equal(records[0].name, "JOE'S PIZZA");
  assert.equal(records[0].lat, 34.05);
  assert.equal(records[0].ref.source, "la_open_data");
});

test("validation fails closed: bbox violations, fake verification claims, missing provenance", () => {
  const drops = freshDrops();
  const good = toReleaseMerchants(HK, dedupeStaged([parseOvertureFeatureLine(overtureLine({}), HK, STAMP, drops)!]));
  assert.deepEqual(validateRelease(HK, good).errors, []);

  const outOfBbox = structuredClone(good);
  outOfBbox[0].location.lat = 35.68;
  assert.ok(validateRelease(HK, outOfBbox).errors.some((e) => e.includes("outside hk bbox")));

  const fakeVerified = structuredClone(good);
  (fakeVerified[0] as { verification_status: string }).verification_status = "phone_verified";
  assert.ok(validateRelease(HK, fakeVerified).errors.some((e) => e.includes("claims verification")));

  const noProv = structuredClone(good);
  noProv[0].source_provenance = [];
  assert.ok(validateRelease(HK, noProv).errors.some((e) => e.includes("no provenance")));
});

test("release: deterministic ids, sorted ndjson, reproducible checksum, honest manifest", async () => {
  assert.equal(
    stableMerchantId("hk", "Lung King Heen", 22.2810004, 114.1580002),
    stableMerchantId("hk", "LUNG KING HEEN", 22.281, 114.158),
  );

  const drops = freshDrops();
  const conflated = dedupeStaged([parseOvertureFeatureLine(overtureLine({}), HK, STAMP, drops)!]);
  const merchants = toReleaseMerchants(HK, conflated);
  const report = validateRelease(HK, merchants);

  const write = () =>
    writeRelease({
      outDir: mkdtempSync(join(tmpdir(), "release-")),
      stamp: "2026-07-16",
      city: HK,
      merchants,
      sources: [{ source: "overture", license: "CDLA-Permissive-2.0", detail: "test", records: 1, retrieved_at: STAMP }],
      crosscheck: null,
      dropped: drops,
      report,
    });
  const first = await write();
  const second = await write();
  assert.equal(first.manifest.checksum_sha256, second.manifest.checksum_sha256);
  assert.equal(first.manifest.release, "2026-07-16-hk");
  assert.ok(first.manifest.unsourced_defaults.includes("reservation_policy"));

  const ndjson = await readFile(join(first.dir, "merchants.ndjson"), "utf8");
  const parsed = ndjson.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].bookable, false);
  assert.equal(parsed[0].verification_status, "unverified");
  assert.equal(parsed[0].timezone, "Asia/Hong_Kong");
});
