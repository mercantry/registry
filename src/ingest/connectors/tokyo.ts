/**
 * Tokyo food-business licence registers — the official register layer for Tokyo.
 * License: CC-BY 4.0 via the 東京都オープンデータカタログ (catalog.data.metro.tokyo.lg.jp);
 * datasets are published per publisher (23 special wards + TMG for Tama/islands),
 * so there is no single consolidated feed. The connector discovers licence-list
 * datasets through the catalog's CKAN search API and ingests every CSV resource
 * that maps to the national licence-ledger export format.
 *
 * Coverage is therefore partial-by-construction (wards publish independently);
 * per-resource counts are logged and the manifest records the total, so the
 * agreement rate stays an honest measure of what the register actually covers.
 *
 * Most ledgers carry no coordinates (a few, e.g. 中野区, ship per-row 緯度/経度 —
 * mapped directly), but municipal-standard rows carry the Address Base Registry
 * join keys (町字ID + 所在地_全国地方公共団体コード), so block-centroid
 * coordinates are filled by ID join (tokyo-geocode.ts) — letting the conflation
 * geo filter arbitrate same-name chain branches. Enrichment-only otherwise,
 * like FEHD: a match is government-attested existence plus the ward.
 */
import type { OfficialRecord } from "./../types.js";
import {
  abrKey,
  errDetail,
  fetchMlitTownIndex,
  fetchTokyoTownNameIndex,
  fetchTokyoTownPosIndex,
  lgKey,
  resolveTownBlock,
  type TownNameIndex,
} from "./tokyo-geocode.js";

export const TOKYO_CKAN_SEARCH = "https://catalog.data.metro.tokyo.lg.jp/api/3/action/package_search";
/** Queries run in order; results are merged and de-duplicated by resource URL. */
export const TOKYO_CKAN_QUERIES = ["食品営業許可", "食品等営業許可・届出", "食品関係営業台帳"];
/** Package titles that are licence/notification ledgers (not statistics or guidance docs). */
const PACKAGE_TITLE_RE = /食品(等)?(営業許可|関係営業台帳|営業許可・届出)/;
/** Cap on CSV resources fetched per run — a runaway catalog match should be loud, not slow. */
export const MAX_RESOURCES = 48;

/**
 * Header synonyms across ward exports. Run-#10 finding: the wards publish the
 * 自治体標準オープンデータセット (municipal-standard) schema — 施設名称 for the
 * name, 所在地_連結表記 for the concatenated address — alongside older
 * ledger-export variants, so both families are mapped.
 */
const HEADERS = {
  name: ["施設名称", "営業所名称", "営業所の名称", "屋号", "施設名", "営業施設名", "名称"],
  address: ["所在地_連結表記", "所在地連結表記", "営業所所在地", "営業所の所在地", "施設所在地", "所在地", "住所"],
  licence: ["許可番号", "許可指令番号", "指令番号", "許可・届出番号"],
  businessType: ["営業の種類", "業種", "許可業種", "業種名", "業態"],
  // Address Base Registry join keys (municipal-standard schema, run-#10 headers).
  // 所在地_ prefixed = the merchant's location; bare 全国地方公共団体コード is the
  // publisher's code — an acceptable fallback since ward ledgers cover their own ward.
  lgCode: ["所在地_全国地方公共団体コード", "全国地方公共団体コード"],
  machiazaId: ["所在地_町字ID", "所在地_町字id", "町字ID", "町字id"],
  // Some wards (中野区, run #22) ship per-row coordinates in the ledger itself —
  // exact positions beat the block-centroid joins, so map them when present.
  lat: ["所在地_緯度", "緯度"],
  lng: ["所在地_経度", "経度"],
} as const;

/**
 * Licence-type-shaped values (飲食店営業, 菓子製造業, 食肉販売業, …) — used only
 * by the mislabeled-column recovery below to tell a licence-type column from a
 * shop-name column by content.
 */
const LICENCE_TYPE_VALUE_RE = /(営業|製造業|販売業|処理業|貯蔵業|運搬業|調理業|採取業|冷凍|冷蔵)/;

/** Restaurant-shaped licence types; post-2021 飲食店営業 subsumes the old 喫茶店営業. */
const RESTAURANT_TYPE_RE = /飲食店|喫茶/;

/** Ward name out of a package/org title, e.g. "新宿区" → district. */
const WARD_RE = /(千代田|中央|港|新宿|文京|台東|墨田|江東|品川|目黒|大田|世田谷|渋谷|中野|杉並|豊島|北|荒川|板橋|練馬|足立|葛飾|江戸川)区/;

export interface TokyoResource {
  url: string;
  label: string;
}

interface CkanPackage {
  title?: string;
  organization?: { title?: string } | null;
  resources?: { url?: string; format?: string; name?: string }[];
}

/** Filter a CKAN package_search response down to licence-ledger CSV resources. */
export function selectLicenceResources(response: unknown, seen = new Set<string>()): TokyoResource[] {
  const results = (response as { result?: { results?: CkanPackage[] } })?.result?.results ?? [];
  const out: TokyoResource[] = [];
  for (const pkg of results) {
    const title = pkg.title ?? "";
    if (!PACKAGE_TITLE_RE.test(title)) continue;
    for (const res of pkg.resources ?? []) {
      if ((res.format ?? "").toUpperCase() !== "CSV") continue;
      if (!res.url || seen.has(res.url)) continue;
      seen.add(res.url);
      out.push({ url: res.url, label: `${pkg.organization?.title ?? ""} ${title} ${res.name ?? ""}`.trim() });
    }
  }
  return out;
}

/** Minimal RFC-4180 CSV parse (quoted fields, CRLF); BOM stripped by the decoder. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

/**
 * Encoding detection: UTF-16 BOM -> utf-16; heavy NUL density -> BOM-less
 * UTF-16LE (run-#10 finding: Shinjuku publishes UTF-16LE); then UTF-8, with a
 * Shift_JIS retry when the replacement-char density says the UTF-8 read is wrong.
 */
export function decodeCsvBuffer(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const strip = (s: string) => s.replace(/^\uFEFF/, "");
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return strip(new TextDecoder("utf-16le").decode(buf));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return strip(new TextDecoder("utf-16be").decode(buf));
  let nuls = 0;
  const probe = Math.min(bytes.length, 4096);
  for (let i = 0; i < probe; i++) if (bytes[i] === 0) nuls++;
  if (probe > 0 && nuls / probe > 0.1) return strip(new TextDecoder("utf-16le").decode(buf));

  const utf8 = strip(new TextDecoder("utf-8").decode(buf));
  const bad = (utf8.match(/\uFFFD/g) ?? []).length;
  if (bad === 0 || bad / Math.max(utf8.length, 1) < 0.001) return utf8;
  try {
    return strip(new TextDecoder("shift_jis").decode(buf));
  } catch {
    return utf8; // no SJIS decoder in this runtime - keep UTF-8, parser will report
  }
}

export function headerIndex(header: string[], candidates: readonly string[]): number {
  const cleaned = header.map((h) => h.replace(/\s+/g, "").trim());
  for (const cand of candidates) {
    const i = cleaned.indexOf(cand);
    if (i >= 0) return i;
  }
  return -1;
}

/** Ledger row + the Address Base Registry join keys (when the schema carries them). */
export interface TokyoLicenceRecord extends OfficialRecord {
  lg_code: string | null;
  machiaza_id: string | null;
}

export interface TokyoParseResult {
  records: TokyoLicenceRecord[];
  skippedReason: string | null;
  rowsFilteredByType: number;
  /** Set when the mislabeled-column recovery re-mapped name/type (中野区 case). */
  recoveredMapping: string | null;
}

/**
 * Mislabeled-column recovery — the 中野区 case (run-#22 alignment dump): the
 * ward ships the municipal-standard header but populates 営業所名称 empty, the
 * trade name under 営業の種類, and the licence type under 業態. Detected by
 * content, never by ward name: the mapped name column must be ≥90% empty, the
 * mapped type column must hold non-licence-type text (the names), and some
 * other column must hold licence-type-shaped values. Any condition failing
 * returns null and the caller keeps today's loud skip — fail-closed.
 */
function detectMislabeledColumns(
  rows: string[][],
  nameI: number,
  typeI: number,
): { nameI: number; typeI: number } | null {
  if (typeI < 0) return null;
  const sample = rows.slice(1, 51);
  if (sample.length === 0) return null;
  const frac = (col: number, pred: (v: string) => boolean) =>
    sample.filter((r) => pred((r[col] ?? "").trim())).length / sample.length;
  if (frac(nameI, (v) => v === "") < 0.9) return null;
  if (frac(typeI, (v) => v !== "" && !LICENCE_TYPE_VALUE_RE.test(v)) < 0.5) return null;
  const width = rows[0].length;
  for (let col = 0; col < width; col++) {
    if (col === nameI || col === typeI) continue;
    if (frac(col, (v) => v !== "" && LICENCE_TYPE_VALUE_RE.test(v)) >= 0.5) {
      return { nameI: typeI, typeI: col };
    }
  }
  return null;
}

/** Parse a ledger coordinate cell; Japan bounds keep placeholder junk out. */
function parseCoord(value: string | undefined, min: number, max: number): number | null {
  const n = Number((value ?? "").trim());
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

/**
 * Parse one licence-ledger CSV into OfficialRecords. Files whose headers don't
 * map to a name + address column are skipped with a reason — counted loudly by
 * the caller, never silently dropped.
 */
export function parseTokyoLicenceCsv(csvText: string, label: string, retrievedAt: string): TokyoParseResult {
  const rows = parseCsv(csvText);
  if (rows.length < 2) {
    return { records: [], skippedReason: "empty or header-only file", rowsFilteredByType: 0, recoveredMapping: null };
  }
  const header = rows[0];
  let nameI = headerIndex(header, HEADERS.name);
  const addrI = headerIndex(header, HEADERS.address);
  const licI = headerIndex(header, HEADERS.licence);
  let typeI = headerIndex(header, HEADERS.businessType);
  const lgI = headerIndex(header, HEADERS.lgCode);
  const mzI = headerIndex(header, HEADERS.machiazaId);
  const latI = headerIndex(header, HEADERS.lat);
  const lngI = headerIndex(header, HEADERS.lng);
  if (nameI < 0 || addrI < 0) {
    return {
      records: [],
      skippedReason: `unmapped headers (saw: ${header.slice(0, 12).join("|")})`,
      rowsFilteredByType: 0,
      recoveredMapping: null,
    };
  }

  let recoveredMapping: string | null = null;
  const remap = detectMislabeledColumns(rows, nameI, typeI);
  if (remap) {
    recoveredMapping =
      `name column "${header[nameI]}" empty — recovered name from "${header[remap.nameI]}" [${remap.nameI}], ` +
      `licence type from "${header[remap.typeI]}" [${remap.typeI}]`;
    nameI = remap.nameI;
    typeI = remap.typeI;
  }

  const district = WARD_RE.exec(label)?.[0] ?? null;
  const records: TokyoLicenceRecord[] = [];
  let filtered = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const name = (row[nameI] ?? "").trim();
    const address = (row[addrI] ?? "").trim();
    if (!name) continue;
    if (typeI >= 0 && row[typeI] && !RESTAURANT_TYPE_RE.test(row[typeI])) {
      filtered++;
      continue;
    }
    const licence = licI >= 0 ? (row[licI] ?? "").trim() : "";
    const lat = latI >= 0 ? parseCoord(row[latI], 20, 46) : null;
    const lng = lngI >= 0 ? parseCoord(row[lngI], 122, 154) : null;
    records.push({
      ref: {
        source: "tokyo_opendata",
        source_id: licence || `${label}#${r}`,
        detail: licence ? `Tokyo food-business licence ${licence} (${label})` : `Tokyo food-business ledger row (${label})`,
        retrieved_at: retrievedAt,
      },
      name,
      name_local: null, // register names ARE the local (Japanese) names
      district,
      address: address || null,
      // Both or neither — a lone coordinate is useless to the geo filter and
      // would block the join fallback from filling the pair.
      lat: lat !== null && lng !== null ? lat : null,
      lng: lat !== null && lng !== null ? lng : null,
      lg_code: lgI >= 0 ? (row[lgI] ?? "").trim() || null : null,
      machiaza_id: mzI >= 0 ? (row[mzI] ?? "").trim() || null : null,
    });
  }
  if (records.length === 0) {
    // 中野区 case (run #11): headers map, data rows exist, zero records kept.
    // Say WHY — all-filtered vs empty name cells — so the next run can tell a
    // legitimately restaurant-free ledger from a column-mapping bug. Run #20
    // showed the name landing in the business-type column (columns shifted vs
    // the header), so dump the full header↔value alignment of the first data
    // row: the log then carries enough to write the mapping fix directly.
    const sample = rows[1] ?? [];
    const typeSample = typeI >= 0 ? ` type sample: "${(sample[typeI] ?? "").trim()}";` : "";
    const aligned = header
      .map((h, i) => `[${i}]${h.replace(/\s+/g, "")}=「${(sample[i] ?? "").trim().slice(0, 24)}」`)
      .join(" ");
    return {
      records,
      skippedReason:
        `headers mapped but 0 restaurant rows kept (${rows.length - 1} data rows; ` +
        `${filtered} filtered by business type;${typeSample} name sample: "${(sample[nameI] ?? "").trim()}"; ` +
        `header ${header.length} cols vs first row ${sample.length} cols; alignment: ${aligned})`,
      rowsFilteredByType: filtered,
      recoveredMapping,
    };
  }
  return { records, skippedReason: null, rowsFilteredByType: filtered, recoveredMapping };
}

export async function fetchTokyoRegister(retrievedAt: string): Promise<OfficialRecord[]> {
  const seen = new Set<string>();
  const resources: TokyoResource[] = [];
  for (const q of TOKYO_CKAN_QUERIES) {
    const url = `${TOKYO_CKAN_SEARCH}?q=${encodeURIComponent(q)}&rows=200`;
    const res = await fetch(url, {
      headers: { "user-agent": "mercantry-ingest/0.1" },
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`tokyo_opendata: CKAN search HTTP ${res.status} for "${q}"`);
    resources.push(...selectLicenceResources(await res.json(), seen));
  }
  if (resources.length === 0) {
    throw new Error("tokyo_opendata: CKAN search returned no licence-ledger CSV resources — catalog may have drifted");
  }
  const capped = resources.slice(0, MAX_RESOURCES);
  if (capped.length < resources.length) {
    console.warn(`[tokyo_opendata] resource cap: ingesting ${capped.length} of ${resources.length} CSVs`);
  }

  const all: TokyoLicenceRecord[] = [];
  let skipped = 0;
  for (const resource of capped) {
    try {
      const res = await fetch(resource.url, {
        headers: { "user-agent": "mercantry-ingest/0.1" },
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = parseTokyoLicenceCsv(decodeCsvBuffer(await res.arrayBuffer()), resource.label, retrievedAt);
      if (parsed.recoveredMapping) {
        console.warn(`[tokyo_opendata] ${resource.label}: mislabeled columns recovered — ${parsed.recoveredMapping}`);
      }
      if (parsed.skippedReason) {
        skipped++;
        console.warn(`[tokyo_opendata] skipped ${resource.label}: ${parsed.skippedReason}`);
      } else {
        console.log(`[tokyo_opendata] ${resource.label}: ${parsed.records.length} records (${parsed.rowsFilteredByType} non-restaurant rows filtered)`);
        all.push(...parsed.records);
      }
    } catch (err) {
      skipped++;
      console.warn(`[tokyo_opendata] skipped ${resource.label}: ${String(err)}`);
    }
  }
  if (all.length === 0) {
    throw new Error(`tokyo_opendata: ${capped.length} resources found but zero records parsed (${skipped} skipped) — format may have drifted`);
  }
  await geocodeTokyoRecords(all);
  return all;
}

/**
 * Fill block centroids from the ABR indexes: the ID join where the ledger row
 * carries both keys, else the town-NAME join (lg_code + the (town, 丁目) pair
 * parsed from the address — the run-#16 pivot, since the wards publish 町字ID
 * empty). Pure so tests can drive it with synthetic indexes.
 */
export function applyTokyoGeocoding(
  records: TokyoLicenceRecord[],
  posIndex: Map<string, { lat: number; lng: number }>,
  nameIndex: TownNameIndex | null,
): { idJoined: number; nameJoined: number } {
  let idJoined = 0;
  let nameJoined = 0;
  for (const rec of records) {
    // Ledger-direct coordinates (中野区 ships 緯度/経度 per row) are exact —
    // never overwrite them with a block centroid.
    if (rec.lat !== null && rec.lng !== null) continue;
    const key = abrKey(rec.lg_code, rec.machiaza_id);
    if (key) {
      const pos = posIndex.get(key);
      if (pos) {
        rec.lat = pos.lat;
        rec.lng = pos.lng;
        idJoined++;
        continue;
      }
    }
    if (!nameIndex || !rec.address) continue;
    const lg = lgKey(rec.lg_code);
    // The ledgers' 6-digit lg_code = 5-digit 市区町村コード + check digit; the
    // MLIT index keys on the 5-digit form, the ABR one on the 6-digit.
    const towns = lg ? (nameIndex.get(lg) ?? (lg.length === 6 ? nameIndex.get(lg.slice(0, 5)) : undefined)) : undefined;
    if (!towns) continue;
    const mzKey = resolveTownBlock(towns, rec.address);
    const pos = mzKey ? posIndex.get(mzKey) : undefined;
    if (pos) {
      rec.lat = pos.lat;
      rec.lng = pos.lng;
      nameJoined++;
    }
  }
  return { idJoined, nameJoined };
}

/**
 * Fill block-centroid coordinates on ledger rows via the Address Base Registry
 * (see tokyo-geocode.ts): ID join first, town-name join for the empty-町字ID
 * rows. Fail-open: without an index the matcher simply keeps today's
 * name+address behavior — but the degradation is loud, because geocoding is
 * what arbitrates same-name chain branches.
 */
export async function geocodeTokyoRecords(records: TokyoLicenceRecord[]): Promise<void> {
  const needing = records.filter((r) => r.lat === null || r.lng === null);
  const direct = records.length - needing.length;
  if (needing.length === 0) {
    console.log(`[tokyo_opendata] geocoding skipped: all ${records.length} rows carry ledger coordinates`);
    return;
  }
  const idBearing = needing.filter((r) => abrKey(r.lg_code, r.machiaza_id) !== null);
  const nameBearing = needing.filter(
    (r) => abrKey(r.lg_code, r.machiaza_id) === null && lgKey(r.lg_code) !== null && r.address !== null,
  );
  if (idBearing.length === 0 && nameBearing.length === 0) {
    // Say WHICH half is missing and what the values look like, or the next run
    // can't distinguish empty columns from a mapping bug (run-#15 lesson).
    const lgVals = needing.map((r) => r.lg_code).filter((v): v is string => v !== null);
    const mzVals = needing.map((r) => r.machiaza_id).filter((v): v is string => v !== null);
    const sample = (vals: string[]) => [...new Set(vals)].slice(0, 3).join("|") || "(none)";
    console.warn(
      `[tokyo_opendata] geocoding skipped: 0 of ${needing.length} coordinate-less rows carry ABR join IDs or an lg_code+address pair ` +
        `(${direct} rows have ledger coordinates; lg_code present: ${lgVals.length}, sample: ${sample(lgVals)}; ` +
        `machiaza_id present: ${mzVals.length}, sample: ${sample(mzVals)})`,
    );
    return;
  }
  let posIndex: Map<string, { lat: number; lng: number }> | null = null;
  let nameIndex: TownNameIndex | null = null;
  let source = "ABR";
  try {
    posIndex = await fetchTokyoTownPosIndex();
  } catch (err) {
    console.warn(`[tokyo_opendata] ABR town positions unavailable — trying MLIT 位置参照情報. ${errDetail(err)}`);
  }
  if (posIndex && nameBearing.length > 0) {
    try {
      nameIndex = await fetchTokyoTownNameIndex();
    } catch (err) {
      console.warn(`[tokyo_opendata] ABR town-name master unavailable — name-join geocoding skipped. ${errDetail(err)}`);
    }
  }
  if (!posIndex) {
    // Run-#18 finding: catalog.registries.digital.go.jp is ENOTFOUND from CI —
    // MLIT's name-keyed block dataset serves both index roles in one file.
    try {
      const mlit = await fetchMlitTownIndex();
      posIndex = mlit.posIndex;
      nameIndex = mlit.byLg;
      source = "MLIT";
    } catch (err) {
      console.warn(`[tokyo_opendata] geocoding unavailable — matching falls back to name+address. ${errDetail(err)}`);
      return;
    }
  }
  const { idJoined, nameJoined } = applyTokyoGeocoding(records, posIndex, nameIndex);
  console.log(
    `[tokyo_opendata] geocoded ${idJoined}/${idBearing.length} ID-join + ${nameJoined}/${nameBearing.length} name-join rows ` +
      `(${direct} ledger-direct, ${records.length} total) against ${posIndex.size} ${source} town blocks`,
  );
}
