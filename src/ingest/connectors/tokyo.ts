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
 * Registers carry no coordinates — enrichment-only, like FEHD: a match is
 * government-attested existence plus the ward (district).
 */
import type { OfficialRecord } from "./../types.js";

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
} as const;

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

function headerIndex(header: string[], candidates: readonly string[]): number {
  const cleaned = header.map((h) => h.replace(/\s+/g, "").trim());
  for (const cand of candidates) {
    const i = cleaned.indexOf(cand);
    if (i >= 0) return i;
  }
  return -1;
}

export interface TokyoParseResult {
  records: OfficialRecord[];
  skippedReason: string | null;
  rowsFilteredByType: number;
}

/**
 * Parse one licence-ledger CSV into OfficialRecords. Files whose headers don't
 * map to a name + address column are skipped with a reason — counted loudly by
 * the caller, never silently dropped.
 */
export function parseTokyoLicenceCsv(csvText: string, label: string, retrievedAt: string): TokyoParseResult {
  const rows = parseCsv(csvText);
  if (rows.length < 2) return { records: [], skippedReason: "empty or header-only file", rowsFilteredByType: 0 };
  const header = rows[0];
  const nameI = headerIndex(header, HEADERS.name);
  const addrI = headerIndex(header, HEADERS.address);
  const licI = headerIndex(header, HEADERS.licence);
  const typeI = headerIndex(header, HEADERS.businessType);
  if (nameI < 0 || addrI < 0) {
    return {
      records: [],
      skippedReason: `unmapped headers (saw: ${header.slice(0, 12).join("|")})`,
      rowsFilteredByType: 0,
    };
  }

  const district = WARD_RE.exec(label)?.[0] ?? null;
  const records: OfficialRecord[] = [];
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
      lat: null,
      lng: null,
    });
  }
  return { records, skippedReason: null, rowsFilteredByType: filtered };
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

  const all: OfficialRecord[] = [];
  let skipped = 0;
  for (const resource of capped) {
    try {
      const res = await fetch(resource.url, {
        headers: { "user-agent": "mercantry-ingest/0.1" },
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = parseTokyoLicenceCsv(decodeCsvBuffer(await res.arrayBuffer()), resource.label, retrievedAt);
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
  return all;
}
