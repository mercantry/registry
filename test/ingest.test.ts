import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CITIES } from "../src/ingest/cities.js";
import { inBbox, matchesAdminExclude, namesMatch, stableMerchantId, toE164 } from "../src/ingest/normalize.js";
import { parseOvertureFeatureLine, type OvertureDropCounts } from "../src/ingest/connectors/overture.js";
import { parseFehdXml } from "../src/ingest/connectors/fehd.js";
import { parseSocrataRows } from "../src/ingest/connectors/losangeles.js";
import { dedupeStaged, enrichWithOfficial, toReleaseMerchants } from "../src/ingest/conflate.js";
import { validateRelease } from "../src/ingest/validate.js";
import { writeRelease } from "../src/ingest/release.js";

const HK = CITIES.hk;
const STAMP = "2026-07-16T00:00:00Z";

const freshDrops = (): OvertureDropCounts => ({ non_restaurant: 0, denied_category: 0, unnamed: 0, no_geometry: 0, out_of_bbox: 0, out_of_admin: 0, no_address: 0, invalid_phone: 0 });

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
  assert.deepEqual(drops, { non_restaurant: 1, denied_category: 0, unnamed: 1, no_geometry: 1, out_of_bbox: 1, out_of_admin: 0, no_address: 3, invalid_phone: 0 });
});

test("category deny-list: non-venue primary drops despite a restaurant alternate; unknown primary keeps", () => {
  const drops = freshDrops();
  // SH run #14's actual noise classes, all of which rode in on alternates.
  // "spas"/"accommodation": run #27's kept-side diagnostic — plurals and the
  // hotel-class synonym Overture actually ships.
  for (const primary of ["massage", "traditional_chinese_medicine", "art_school", "college_university", "hotel", "water_treatment_supplier", "beauty_salon", "spas", "accommodation", "hostels"]) {
    assert.equal(
      parseOvertureFeatureLine(overtureLine({ categories: { primary, alternate: ["restaurant"] } }), HK, STAMP, drops),
      null,
      `should deny primary=${primary}`,
    );
  }
  assert.equal(drops.denied_category, 10);
  // Fail-safe side: unlisted primaries, absent primaries, and any primary
  // naming a restaurant always keep. "desserts" also proves the plural
  // stripping can't invent a match ("dessert" isn't a deny term).
  assert.ok(parseOvertureFeatureLine(overtureLine({ categories: { primary: "izakaya", alternate: ["restaurant"] } }), HK, STAMP, drops));
  assert.ok(parseOvertureFeatureLine(overtureLine({ categories: { alternate: ["restaurant"] } }), HK, STAMP, drops));
  assert.ok(parseOvertureFeatureLine(overtureLine({ categories: { primary: "hotel_restaurant", alternate: ["restaurant"] } }), HK, STAMP, drops));
  assert.ok(parseOvertureFeatureLine(overtureLine({ categories: { primary: "desserts", alternate: ["restaurant"] } }), HK, STAMP, drops));
  assert.equal(drops.denied_category, 10);
});

test("neighborhood hygiene: city-self labels (any script), council districts and bare codes become absent", () => {
  const SH = CITIES.sh;
  const shLine = (addr: Record<string, string>) =>
    JSON.stringify({
      type: "Feature",
      geometry: { type: "Point", coordinates: [121.47, 31.23] },
      properties: { names: { primary: "老弄堂" }, categories: { primary: "chinese_restaurant" }, addresses: [{ freeform: "南京东路300号", ...addr }] },
    });
  const drops = freshDrops();
  // Run #14: 上海市/上海 arrive as district AND locality — both blank out.
  assert.equal(parseOvertureFeatureLine(shLine({ district: "上海市" }), SH, STAMP, drops)?.neighborhood, "");
  assert.equal(parseOvertureFeatureLine(shLine({ locality: "上海" }), SH, STAMP, drops)?.neighborhood, "");
  // A junk district falls back to a real locality instead of shadowing it.
  assert.equal(parseOvertureFeatureLine(shLine({ district: "上海市", locality: "Xuhui" }), SH, STAMP, drops)?.neighborhood, "Xuhui");
  assert.equal(parseOvertureFeatureLine(shLine({ district: "徐汇区" }), SH, STAMP, drops)?.neighborhood, "徐汇区");
  // LA: administrative code labels carry no neighborhood information.
  const la = CITIES.la;
  const laLine = (addr: Record<string, string>) =>
    JSON.stringify({
      type: "Feature",
      geometry: { type: "Point", coordinates: [-118.25, 34.05] },
      properties: { names: { primary: "Grand Central Deli" }, categories: { primary: "restaurant" }, addresses: [{ freeform: "317 S Broadway", ...addr }] },
    });
  assert.equal(parseOvertureFeatureLine(laLine({ district: "Council District 9" }), la, STAMP, drops)?.neighborhood, "");
  assert.equal(parseOvertureFeatureLine(laLine({ district: "9" }), la, STAMP, drops)?.neighborhood, "");
  assert.equal(parseOvertureFeatureLine(laLine({ district: "Los Angeles" }), la, STAMP, drops)?.neighborhood, "");
  assert.equal(parseOvertureFeatureLine(laLine({ district: "Silver Lake" }), la, STAMP, drops)?.neighborhood, "Silver Lake");
  // Tokyo: 東京都 as locality blanks; a ward name stays.
  const tokyo = CITIES.tokyo;
  const tkLine = (addr: Record<string, string>) =>
    JSON.stringify({
      type: "Feature",
      geometry: { type: "Point", coordinates: [139.7, 35.68] },
      properties: { names: { primary: "鮨処" }, categories: { primary: "japanese_restaurant" }, addresses: [{ freeform: "西新宿6丁目6-2", ...addr }] },
    });
  assert.equal(parseOvertureFeatureLine(tkLine({ locality: "東京都" }), tokyo, STAMP, drops)?.neighborhood, "");
  assert.equal(parseOvertureFeatureLine(tkLine({ locality: "Shinjuku" }), tokyo, STAMP, drops)?.neighborhood, "Shinjuku");
  assert.equal(drops.denied_category, 0);
});

test("admin-boundary filter: affirmative metadata mismatch drops, absent metadata keeps", () => {
  const drops = freshDrops();
  // Shenzhen record inside the HK bbox (north of the Sham Chun River): dropped.
  assert.equal(
    parseOvertureFeatureLine(
      overtureLine({
        geometry: { type: "Point", coordinates: [114.06, 22.545] },
        addresses: [{ freeform: "深南大道123号", locality: "Futian", country: "CN" }],
      }),
      HK, STAMP, drops,
    ),
    null,
  );
  assert.equal(drops.out_of_admin, 1);
  // HK's own records (country HK) and metadata-less records always stay.
  assert.ok(parseOvertureFeatureLine(overtureLine({ addresses: [{ freeform: "8 Finance St", country: "HK" }] }), HK, STAMP, drops));
  assert.ok(parseOvertureFeatureLine(overtureLine({ addresses: [{ freeform: "8 Finance St" }] }), HK, STAMP, drops));
  assert.equal(drops.out_of_admin, 1);

  // Tokyo: Kawasaki (JP-14) inside the bbox's south edge drops — full ISO code
  // or bare subdivision + country both canonicalize; JP-13 and bare-region-only
  // (uninterpretable) records stay.
  const tokyo = CITIES.tokyo;
  const tokyoLine = (addr: Record<string, string>) =>
    JSON.stringify({
      type: "Feature",
      geometry: { type: "Point", coordinates: [139.7, 35.54] },
      properties: { names: { primary: "ラゾーナ食堂" }, categories: { primary: "japanese_restaurant" }, addresses: [{ freeform: "幸区堀川町72-1", ...addr }] },
    });
  const tDrops = freshDrops();
  assert.equal(parseOvertureFeatureLine(tokyoLine({ region: "JP-14", country: "JP" }), tokyo, STAMP, tDrops), null);
  assert.equal(parseOvertureFeatureLine(tokyoLine({ region: "14", country: "JP" }), tokyo, STAMP, tDrops), null);
  // Run #25's actual encodings: free-text prefecture names, several romanizations.
  for (const region of ["神奈川県", "Kanagawa", "Kanagawa-ken", "Kanagawa Prefecture", "埼玉県", "千葉県", "Chiba", "SAITAMA"]) {
    assert.equal(parseOvertureFeatureLine(tokyoLine({ region }), tokyo, STAMP, tDrops), null, `should drop region=${region}`);
  }
  assert.ok(parseOvertureFeatureLine(tokyoLine({ region: "JP-13", country: "JP" }), tokyo, STAMP, tDrops));
  assert.ok(parseOvertureFeatureLine(tokyoLine({ region: "東京都" }), tokyo, STAMP, tDrops));
  assert.ok(parseOvertureFeatureLine(tokyoLine({ region: "14" }), tokyo, STAMP, tDrops)); // no country → can't canonicalize → keep
  assert.equal(tDrops.out_of_admin, 10);

  // A rule never fires on empty metadata even when it specifies nothing.
  assert.equal(matchesAdminExclude(undefined, undefined, [{}]), false);
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
  // CN (Shanghai): mobiles, 021 landlines, already-E.164; junk stays null.
  assert.equal(toE164("139 1234 5678", "CN"), "+8613912345678");
  assert.equal(toE164("021-6123 4567", "CN"), "+862161234567");
  assert.equal(toE164("+86 21 6123 4567", "CN"), "+862161234567");
  assert.equal(toE164("6123 4567", "CN"), null); // area-code-less landline: ambiguous, refuse
});

test("shanghai config: bbox sanity and honest register-less setup", () => {
  const SH = CITIES.sh;
  assert.equal(SH.country, "CN");
  assert.equal(SH.timezone, "Asia/Shanghai");
  assert.deepEqual(SH.officialSources, []); // no clean-source register — honest
  assert.ok(inBbox(31.23, 121.47, SH.bbox)); // People's Square
  assert.ok(inBbox(31.22, 121.53, SH.bbox)); // Lujiazui
  assert.ok(!inBbox(31.23, 120.62, SH.bbox)); // Suzhou stays out
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

test("tokyo geocoding: ABR ID capture, town-pos parse, zip handling, chain arbitration", async () => {
  const { parseTokyoLicenceCsv, geocodeTokyoRecords } = await import("../src/ingest/connectors/tokyo.js");
  const { abrKey, parseTownPosCsv, decodeCsvOrZip, selectTownPosResources } = await import(
    "../src/ingest/connectors/tokyo-geocode.js"
  );
  const { deflateRawSync } = await import("node:zlib");

  // Join keys captured from the municipal-standard schema; absent columns → null.
  const standard =
    "全国地方公共団体コード,施設名称,営業の種類,所在地_連結表記,所在地_全国地方公共団体コード,所在地_町字ID\n" +
    "131041,鮨 はまだ,飲食店営業,東京都新宿区西新宿6丁目6-2,131041,0001000\n";
  const withIds = parseTokyoLicenceCsv(standard, "新宿区 食品営業許可一覧", STAMP);
  assert.equal(withIds.records[0].lg_code, "131041");
  assert.equal(withIds.records[0].machiaza_id, "0001000");
  const legacy = parseTokyoLicenceCsv("許可番号,営業所名称,営業所所在地\n1,店,住所1-1\n", "テスト区", STAMP);
  assert.equal(legacy.records[0].lg_code, null);
  assert.equal(legacy.records[0].machiaza_id, null);

  // Key normalization: zero-padding differences can't miss; empty parts never join.
  assert.equal(abrKey("131041", "0001000"), abrKey("0131041", "1000"));
  assert.equal(abrKey("131041", ""), null);
  assert.equal(abrKey(null, "1000"), null);

  // Town-pos CSV: Japanese and snake_case header families both map; drift skips loudly.
  const posJa =
    "全国地方公共団体コード,町字id,代表点_経度,代表点_緯度\n" +
    "131041,0001000,139.6917,35.6895\n" +
    "131041,0002000,,\n";
  const ja = parseTownPosCsv(posJa);
  assert.equal(ja.skippedReason, null);
  assert.equal(ja.index.size, 1); // blank-coordinate row skipped, never NaN
  assert.deepEqual(ja.index.get(abrKey("131041", "0001000")!), { lat: 35.6895, lng: 139.6917 });
  const en = parseTownPosCsv("lg_code,machiaza_id,rep_lon,rep_lat\n131041,0001000,139.6917,35.6895\n");
  assert.equal(en.index.size, 1);
  assert.ok(parseTownPosCsv("foo,bar\n1,2\n").skippedReason?.includes("unmapped ABR headers"));

  // ZIP: stored + deflated entries both extract; non-zip buffers pass through.
  const buildZip = (entries: { name: string; content: string; method: 0 | 8 }[]): ArrayBuffer => {
    const encoder = new TextEncoder();
    const parts: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;
    for (const e of entries) {
      const nameB = encoder.encode(e.name);
      const raw = encoder.encode(e.content);
      const data = e.method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw;
      const local = new Uint8Array(30 + nameB.length + data.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(8, e.method, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, raw.length, true);
      lv.setUint16(26, nameB.length, true);
      local.set(nameB, 30);
      local.set(data, 30 + nameB.length);
      const cent = new Uint8Array(46 + nameB.length);
      const cv = new DataView(cent.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(10, e.method, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, raw.length, true);
      cv.setUint16(28, nameB.length, true);
      cv.setUint32(42, offset, true);
      cent.set(nameB, 46);
      parts.push(local);
      central.push(cent);
      offset += local.length;
    }
    const cdSize = central.reduce((s, c) => s + c.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    const all = new Uint8Array(offset + cdSize + 22);
    let p = 0;
    for (const part of [...parts, ...central, eocd]) {
      all.set(part, p);
      p += part.length;
    }
    return all.buffer;
  };
  const zipped = buildZip([
    { name: "mt_town_pos_pref13.csv", content: posJa, method: 8 },
    { name: "readme.txt", content: "ignored", method: 0 },
  ]);
  assert.equal(parseTownPosCsv(decodeCsvOrZip(zipped)).index.size, 1);
  const stored = buildZip([{ name: "pos.csv", content: posJa, method: 0 }]);
  assert.equal(parseTownPosCsv(decodeCsvOrZip(stored)).index.size, 1);
  assert.equal(parseTownPosCsv(decodeCsvOrZip(new TextEncoder().encode(posJa).buffer as ArrayBuffer)).index.size, 1);

  // CKAN fallback selector: Tokyo town-pos resources in, other prefectures/doc formats out.
  const picked = selectTownPosResources({
    result: {
      results: [
        {
          title: "町字マスター位置参照拡張 東京都",
          resources: [
            { url: "https://x.test/mt_town_pos_pref13.csv.zip", format: "ZIP" },
            { url: "https://x.test/spec.pdf", format: "PDF" },
          ],
        },
        { title: "町字マスター位置参照拡張 大阪府", resources: [{ url: "https://x.test/mt_town_pos_pref27.csv.zip", format: "ZIP" }] },
        { title: "統計データ", resources: [{ url: "https://x.test/pref13_stats.csv", format: "CSV" }] },
      ],
    },
  });
  assert.deepEqual(picked, ["https://x.test/mt_town_pos_pref13.csv.zip"]);

  // The point of all this: block coordinates let the geo filter arbitrate
  // same-name chain branches that address matching alone leaves ambiguous.
  const drops = freshDrops();
  const branchA = parseOvertureFeatureLine(
    overtureLine({ id: "gers-a", names: { primary: "鮨 はまだ" }, geometry: { type: "Point", coordinates: [114.16, 22.28] }, addresses: [{ freeform: "金鐘道88號" }] }),
    HK, STAMP, drops,
  )!;
  const branchB = parseOvertureFeatureLine(
    overtureLine({ id: "gers-b", names: { primary: "鮨 はまだ" }, geometry: { type: "Point", coordinates: [114.19, 22.336] }, addresses: [{ freeform: "沙田正街1號" }] }),
    HK, STAMP, drops,
  )!;
  const conflated = dedupeStaged([branchA, branchB]);
  assert.equal(conflated.length, 2);
  const rec = withIds.records[0];
  rec.address = "別のフォーマットの住所"; // address arbitration can't fire — geo must
  const ungeocoded = enrichWithOfficial(conflated, [structuredClone(rec)]);
  assert.deepEqual(ungeocoded, { matched: 0, ambiguous: 1, unmatched: 0 });
  rec.lat = 22.281; // ~150m from branch A, ~6km from branch B
  rec.lng = 114.158;
  const geocoded = enrichWithOfficial(conflated, [rec]);
  assert.deepEqual(geocoded, { matched: 1, ambiguous: 0, unmatched: 0 });
  assert.equal(conflated[0].official.length + conflated[1].official.length, 1);

  // geocodeTokyoRecords is fail-open offline: no join-key-bearing rows → quiet no-op.
  await geocodeTokyoRecords(legacy.records);
  assert.equal(legacy.records[0].lat, null);
});

test("tokyo name-join geocoding: 町字マスター parse, address resolution, empty-ID pivot", async () => {
  const { parseTokyoLicenceCsv, applyTokyoGeocoding } = await import("../src/ingest/connectors/tokyo.js");
  const { abrKey, kanjiNumeral, townText, parseTownNameCsv, resolveTownBlock, selectTownMasterResources } =
    await import("../src/ingest/connectors/tokyo-geocode.js");

  // 丁目 numerals: arabic and kanji both parse; juxtaposed digits never guess.
  assert.equal(kanjiNumeral("六"), 6);
  assert.equal(kanjiNumeral("十"), 10);
  assert.equal(kanjiNumeral("十二"), 12);
  assert.equal(kanjiNumeral("二十三"), 23);
  assert.equal(kanjiNumeral("6"), 6);
  assert.equal(kanjiNumeral(""), null);
  assert.equal(kanjiNumeral("三五"), null);

  // Normalization: full-width digits, small-ke, kanji 丁目 all fold.
  assert.equal(townText("西新宿六丁目６番２号"), "西新宿6丁目6番2号");
  assert.equal(townText("霞ヶ丘町"), "霞ケ丘町");

  // Master parse: koaza rows skipped; a (name, 丁目) pair with two machiaza_ids is dropped.
  const townCsv =
    "全国地方公共団体コード,町字id,大字・町名,丁目名,小字名\n" +
    "131041,0001006,西新宿,六丁目,\n" +
    "131041,0002003,新宿,三丁目,\n" +
    "131041,0002006,新宿,六丁目,\n" +
    "131041,0003000,矢来町,,\n" +
    "131041,0005000,愛住町,,字北裏\n" +
    "131041,0004001,重複,一丁目,\n" +
    "131041,0004999,重複,一丁目,\n";
  const master = parseTownNameCsv(townCsv);
  assert.equal(master.skippedReason, null);
  const shinjuku = master.byLg.get("131041")!;
  assert.equal(shinjuku.get("西新宿")?.get(6), abrKey("131041", "0001006"));
  assert.equal(shinjuku.get("愛住町"), undefined); // koaza subdivision, skipped
  assert.equal(shinjuku.get("重複")?.get(1), undefined); // ambiguous, dropped
  assert.ok(parseTownNameCsv("foo,bar\n1,2\n").skippedReason?.includes("unmapped ABR town headers"));

  // Address resolution: kanji 丁目, hyphen format, 丁目-less towns; longest
  // name wins (西新宿6… must not resolve through 新宿6…); no invention.
  assert.equal(resolveTownBlock(shinjuku, "東京都新宿区西新宿六丁目6番2号"), abrKey("131041", "0001006"));
  assert.equal(resolveTownBlock(shinjuku, "東京都新宿区西新宿6-6-2"), abrKey("131041", "0001006"));
  assert.equal(resolveTownBlock(shinjuku, "東京都新宿区新宿3-14-1"), abrKey("131041", "0002003"));
  assert.equal(resolveTownBlock(shinjuku, "東京都新宿区矢来町123番地"), abrKey("131041", "0003000"));
  assert.equal(resolveTownBlock(shinjuku, "東京都新宿区存在しない町1-1"), null);

  // The pivot end-to-end: municipal-standard rows with lg_code but an EMPTY
  // 町字ID column (the run-#16 ward reality) geocode through the name join;
  // ID-bearing rows still take the ID join.
  const ledger =
    "施設名称,営業の種類,所在地_連結表記,所在地_全国地方公共団体コード,所在地_町字ID\n" +
    "鮨 はまだ,飲食店営業,東京都新宿区西新宿六丁目6番2号,131041,\n" +
    "ラーメン花,飲食店営業,東京都新宿区新宿3-14-1,131041,0002003\n" +
    "喫茶みどり,飲食店営業,東京都新宿区未知町9-9,131041,\n";
  const parsed = parseTokyoLicenceCsv(ledger, "新宿区 食品営業許可一覧", STAMP);
  assert.equal(parsed.records.length, 3);
  assert.equal(parsed.records[0].machiaza_id, null);
  const posIndex = new Map([
    [abrKey("131041", "0001006")!, { lat: 35.6895, lng: 139.6917 }],
    [abrKey("131041", "0002003")!, { lat: 35.6909, lng: 139.7043 }],
  ]);
  const joined = applyTokyoGeocoding(parsed.records, posIndex, master.byLg);
  assert.deepEqual(joined, { idJoined: 1, nameJoined: 1 });
  assert.equal(parsed.records[0].lat, 35.6895);
  assert.equal(parsed.records[1].lng, 139.7043);
  assert.equal(parsed.records[2].lat, null); // unknown town stays ungeocoded
  // Without the name index the ID join alone still works (fail-open shape).
  const idOnly = parseTokyoLicenceCsv(ledger, "新宿区", STAMP);
  assert.deepEqual(applyTokyoGeocoding(idOnly.records, posIndex, null), { idJoined: 1, nameJoined: 0 });

  // MLIT 位置参照情報 fallback: name+position in one file, 5-digit 市区町村コード
  // keys, kanji 丁目 folded into 大字町丁目名 — ledger rows with 6-digit lg_code
  // still resolve via the check-digit-stripping fallback.
  const { parseMlitTownCsv } = await import("../src/ingest/connectors/tokyo-geocode.js");
  const mlitCsv =
    "都道府県コード,都道府県名,市区町村コード,市区町村名,大字町丁目コード,大字町丁目名,緯度,経度\n" +
    "13,東京都,13104,新宿区,131040001006,西新宿六丁目,35.6895,139.6917\n" +
    "13,東京都,13104,新宿区,131040002003,新宿三丁目,35.6909,139.7043\n" +
    "13,東京都,13104,新宿区,131040003000,矢来町,35.7010,139.7350\n" +
    "13,東京都,13104,新宿区,131040009001,重複一丁目,35.1,139.1\n" +
    "13,東京都,13104,新宿区,131040009002,重複一丁目,35.2,139.2\n";
  const mlit = parseMlitTownCsv(mlitCsv);
  assert.equal(mlit.skippedReason, null);
  const mlitShinjuku = mlit.byLg.get("13104")!;
  assert.ok(mlitShinjuku.get("西新宿")?.has(6));
  assert.equal(mlitShinjuku.get("重複")?.get(1), undefined); // ambiguous coords dropped
  const mlitLedger = parseTokyoLicenceCsv(ledger, "新宿区", STAMP);
  const mlitJoined = applyTokyoGeocoding(mlitLedger.records, mlit.posIndex, mlit.byLg);
  // No real machiaza keys in the MLIT posIndex → the ID-bearing row falls
  // through to the name join too; both geocodable rows land, unknown town stays null.
  assert.deepEqual(mlitJoined, { idJoined: 0, nameJoined: 2 });
  assert.equal(mlitLedger.records[0].lat, 35.6895);
  assert.equal(mlitLedger.records[1].lat, 35.6909);
  assert.equal(mlitLedger.records[2].lat, null);
  assert.ok(parseMlitTownCsv("foo,bar\n1,2\n").skippedReason?.includes("unmapped MLIT headers"));

  // CKAN selector: the master package in, the 位置参照拡張 variant and other prefectures out.
  const picked = selectTownMasterResources({
    result: {
      results: [
        { title: "町字マスター 東京都", resources: [{ url: "https://x.test/mt_town_pref13.csv.zip", format: "ZIP" }] },
        { title: "町字マスター位置参照拡張 東京都", resources: [{ url: "https://x.test/mt_town_pos_pref13.csv.zip", format: "ZIP" }] },
        { title: "町字マスター 大阪府", resources: [{ url: "https://x.test/mt_town_pref27.csv.zip", format: "ZIP" }] },
      ],
    },
  });
  assert.deepEqual(picked, ["https://x.test/mt_town_pref13.csv.zip"]);
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
      council_district: "9",
    },
    { business_name: "VALLEY CAFE", city: "BURBANK", naics: "722511" },
  ];
  const records = parseSocrataRows(rows, STAMP);
  assert.equal(records.length, 1);
  assert.equal(records[0].name, "JOE'S PIZZA");
  assert.equal(records[0].lat, 34.05);
  assert.equal(records[0].ref.source, "la_open_data");
  // council_district never becomes a neighborhood label (run #27: the register
  // fallback had filled top_neighborhoods with "Council District N").
  assert.equal(records[0].district, null);
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
      aliasEnrichment: null,
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

test("wikidata connector: query carries bbox + langs; SPARQL parse keeps only local-name rows", async () => {
  const { buildWikidataQuery, parseWikidataResults } = await import("../src/ingest/connectors/wikidata.js");
  const query = buildWikidataQuery(HK);
  assert.ok(query.includes("Point(113.83 22.15)"));
  assert.ok(query.includes("Point(114.41 22.57)"));
  assert.ok(query.includes('"zh", "zh-hk", "zh-hant", "yue"'));
  assert.ok(query.includes("wd:Q11707"));

  const json = {
    results: {
      bindings: [
        {
          item: { value: "http://www.wikidata.org/entity/Q123" },
          coord: { value: "Point(114.158 22.281)" },
          en: { value: "Lung King Heen" },
          locals: { value: "龍景軒\u001F龍景軒" }, // duplicate label collapses
        },
        // No local name → useless to this connector, dropped.
        { item: { value: "http://www.wikidata.org/entity/Q124" }, coord: { value: "Point(114.16 22.28)" }, en: { value: "English Only" }, locals: { value: "" } },
        // Malformed coordinate → skipped, never guessed.
        { item: { value: "http://www.wikidata.org/entity/Q125" }, coord: { value: "not a point" }, locals: { value: "壞座標" } },
      ],
    },
  };
  const places = parseWikidataResults(json, STAMP);
  assert.equal(places.length, 1);
  assert.equal(places[0].ref.source_id, "Q123");
  assert.equal(places[0].ref.source, "wikidata");
  assert.deepEqual(places[0].names_local, ["龍景軒"]);
  assert.equal(places[0].lat, 22.281);
  assert.equal(places[0].lng, 114.158);
  assert.throws(() => parseWikidataResults({ error: "boom" }, STAMP), /SPARQL/);
});

test("wikidata enrichment: unique geo+name match adds alias + provenance; ambiguous chain and no-match skipped", async () => {
  const { enrichWithWikidata } = await import("../src/ingest/conflate.js");
  const drops = freshDrops();
  const line = (name: string, lng: number, lat: number) =>
    overtureLine({ names: { primary: name }, geometry: { type: "Point", coordinates: [lng, lat] } });
  const conflated = dedupeStaged([
    parseOvertureFeatureLine(line("Lung King Heen", 114.158, 22.281), HK, STAMP, drops)!,
    // Chain: same name, two branches ~450 m apart (past dedupe, inside the wikidata radius).
    parseOvertureFeatureLine(line("Golden Duck", 114.17, 22.3), HK, STAMP, drops)!,
    parseOvertureFeatureLine(line("Golden Duck", 114.17, 22.304), HK, STAMP, drops)!,
  ]);
  assert.equal(conflated.length, 3);

  const item = (qid: string, en: string | null, locals: string[], lng: number, lat: number) => ({
    ref: { source: "wikidata", source_id: qid, detail: `Wikidata entity ${qid} (CC0 labels/aliases)`, retrieved_at: STAMP },
    name_en: en,
    names_local: locals,
    lat,
    lng,
  });
  const stats = enrichWithWikidata(conflated, [
    item("Q1", "Lung King Heen", ["龍景軒"], 114.1585, 22.2812), // unique → enriches
    item("Q2", "Golden Duck", ["金鴨"], 114.17, 22.302), // both branches in radius → ambiguous, skipped
    item("Q3", "Nowhere House", ["無處樓"], 114.4, 22.55), // no name match → unmatched
  ]);
  assert.deepEqual(stats, { matched: 1, ambiguous: 1, unmatched: 1, aliases_added: 1 });

  const lkh = conflated.find((p) => p.name === "Lung King Heen")!;
  assert.ok(lkh.aliases.includes("龍景軒"));
  assert.ok(!conflated.some((p) => p.aliases.includes("金鴨"))); // ambiguous never wrote

  const merchants = toReleaseMerchants(HK, conflated);
  const m = merchants.find((x) => x.name === "Lung King Heen")!;
  assert.ok(m.source_provenance.some((p) => p.source === "wikidata" && p.field === "aliases"));

  // Idempotent on re-run: matches again, adds nothing new.
  const rerun = enrichWithWikidata(conflated, [item("Q1", "Lung King Heen", ["龍景軒"], 114.1585, 22.2812)]);
  assert.deepEqual(rerun, { matched: 1, ambiguous: 0, unmatched: 0, aliases_added: 0 });
});

test("tokyo ledger: mapped headers with zero kept rows skip loudly with cause (中野区 diagnosis)", async () => {
  const { parseTokyoLicenceCsv } = await import("../src/ingest/connectors/tokyo.js");
  const csv = "許可番号,営業所名称,営業所所在地,業種\n1,パン工房アン,北新宿1-1-1,菓子製造業\n";
  const parsed = parseTokyoLicenceCsv(csv, "中野区 食品営業許可一覧", STAMP);
  assert.equal(parsed.records.length, 0);
  assert.equal(parsed.recoveredMapping, null); // name column has data — recovery must not fire
  assert.ok(parsed.skippedReason?.includes("0 restaurant rows kept"));
  assert.ok(parsed.skippedReason?.includes("1 filtered by business type"));
  assert.ok(parsed.skippedReason?.includes("菓子製造業"));
});

test("tokyo ledger: 中野区 mislabeled columns recovered by content + ledger-direct coordinates (run #22)", async () => {
  const { parseTokyoLicenceCsv, applyTokyoGeocoding } = await import("../src/ingest/connectors/tokyo.js");
  // Run-#22 alignment: 営業所名称 empty, trade name under 営業の種類, licence
  // type under 業態, per-row 経度/緯度 present.
  const header = "市区町村コード,営業所名称,営業の種類,業態,営業所所在地,許可番号,経度,緯度\n";
  const csv =
    header +
    ",,洋食屋さん　レストラントロワ・フェザン,【～Ｒ３．５】飲食店営業（一般・その他）,南台一丁目１番２号,30中環生食第433号,139.677739,35.687349\n" +
    ",,ケーキハウスもみじ,菓子製造業,中野二丁目２番２号,30中環生食第500号,139.665000,35.700000\n" +
    ",,喫茶みどり,喫茶店営業,新井一丁目３番,30中環生食第501号,,\n";
  const parsed = parseTokyoLicenceCsv(csv, "中野区 食品等営業許可届出一覧", STAMP);
  assert.ok(parsed.recoveredMapping?.includes("営業の種類"));
  assert.ok(parsed.recoveredMapping?.includes("業態"));
  assert.equal(parsed.skippedReason, null);
  assert.equal(parsed.records.length, 2); // 菓子製造業 filtered via the recovered type column
  assert.equal(parsed.rowsFilteredByType, 1);
  assert.equal(parsed.records[0].name, "洋食屋さん　レストラントロワ・フェザン");
  assert.equal(parsed.records[0].district, "中野区");
  assert.equal(parsed.records[0].ref.source_id, "30中環生食第433号");
  // Ledger-direct coordinates land on the record; missing pair stays null.
  assert.equal(parsed.records[0].lat, 35.687349);
  assert.equal(parsed.records[0].lng, 139.677739);
  assert.equal(parsed.records[1].lat, null);

  // Direct coordinates are never overwritten by block centroids.
  const posIndex = new Map([["dummy", { lat: 0, lng: 0 }]]);
  const before = { lat: parsed.records[0].lat, lng: parsed.records[0].lng };
  applyTokyoGeocoding(parsed.records, posIndex, null);
  assert.equal(parsed.records[0].lat, before.lat);
  assert.equal(parsed.records[0].lng, before.lng);
});

test("tokyo ledger: coordinate columns validated to Japan bounds; lone coordinate dropped", async () => {
  const { parseTokyoLicenceCsv } = await import("../src/ingest/connectors/tokyo.js");
  const csv =
    "営業所名称,営業所所在地,経度,緯度\n" +
    "そば処 やぶ,中野一丁目1-1,0,0\n" + // placeholder junk outside Japan bounds
    "鮨処 うみ,中野二丁目2-2,139.66,\n"; // lone longitude
  const parsed = parseTokyoLicenceCsv(csv, "中野区", STAMP);
  assert.equal(parsed.recoveredMapping, null);
  assert.equal(parsed.records.length, 2);
  for (const rec of parsed.records) {
    assert.equal(rec.lat, null);
    assert.equal(rec.lng, null);
  }
});

test("register-evidence source keys match what connectors emit (tokyo_opendata fix)", async () => {
  const { OFFICIAL_SOURCES: qaSources } = await import("../src/ingest/qa.js");
  const { OFFICIAL_SOURCES: trancheSources } = await import("../src/ingest/tranche.js");
  for (const sources of [qaSources, trancheSources]) {
    assert.ok(sources.has("tokyo_opendata"));
    assert.ok(!sources.has("tokyo_open_data"));
    assert.ok(sources.has("fehd_hk"));
    assert.ok(sources.has("la_open_data"));
  }
  // CC0 labels corroborate names but are NOT government-register evidence.
  assert.ok(!qaSources.has("wikidata"));
});

test("qa gate: single-CJK-char names are legitimate (run-#20 杉/紡 false positive); single Latin char is not", async () => {
  const { wellFormednessFailure } = await import("../src/ingest/qa.js");
  const mk = (name: string) =>
    toReleaseMerchants(
      HK,
      dedupeStaged([
        parseOvertureFeatureLine(
          overtureLine({ names: { primary: name }, addresses: [{ freeform: "鳳德商場" }] }),
          HK, STAMP, freshDrops(),
        )!,
      ]),
    )[0];
  assert.equal(wellFormednessFailure(mk("杉"), "hk"), null);
  assert.equal(wellFormednessFailure(mk("紡"), "hk"), null);
  assert.ok(wellFormednessFailure(mk("A"), "hk")?.includes("too short"));
});
