/**
 * Tokyo register geocoding — Address Base Registry town-block representative points.
 *
 * The ward licence ledgers (municipal-standard schema) carry 町字ID +
 * 所在地_全国地方公共団体コード but no coordinates. The Digital Agency's
 * アドレス・ベース・レジストリ publishes 町字マスター位置参照拡張 (town-block
 * representative points) keyed by exactly those two IDs, so register geocoding
 * is an ID JOIN, not address parsing: lgCode + 町字ID → block centroid, filled
 * into OfficialRecord.lat/lng so the conflation ≤0.5km geo filter can arbitrate
 * same-name chain branches in different neighborhoods. Same-block branches
 * honestly stay ambiguous — block precision is all this claims.
 *
 * License: 公共データ利用規約（第1.0版）/ PDL 1.0 (CC-BY-4.0-compatible
 * government open license) via catalog.registries.digital.go.jp.
 *
 * Fetch strategy: the well-known per-prefecture download path first, then CKAN
 * package_search discovery (same pattern as the ward-ledger connector). Either
 * may serve a ZIP — a minimal reader handles stored + deflated entries.
 */
import { inflateRawSync } from "node:zlib";
import { decodeCsvBuffer, headerIndex, parseCsv } from "./tokyo.js";

/** Tokyo-to (prefecture 13) town-block representative points, published per prefecture. */
export const ABR_TOWN_POS_URL =
  "https://catalog.registries.digital.go.jp/rsc/address/mt_town_pos_pref13.csv.zip";
export const ABR_CKAN_SEARCH =
  "https://catalog.registries.digital.go.jp/rc/api/3/action/package_search";
export const ABR_CKAN_QUERIES = ["町字マスター位置参照拡張", "位置参照拡張"];
/** 町字マスター (town-name master) — carries the names the ledgers' empty-ID rows join through. */
export const ABR_TOWN_URL =
  "https://catalog.registries.digital.go.jp/rsc/address/mt_town_pref13.csv.zip";
export const ABR_TOWN_CKAN_QUERIES = ["町字マスター 東京都", "町字マスター"];

/**
 * MLIT 位置参照情報 (大字・町丁目レベル) — the fallback position source.
 * Run-#18 finding: catalog.registries.digital.go.jp is ENOTFOUND from CI, so
 * the ABR path may be entirely unreachable. MLIT's block-level dataset carries
 * 市区町村コード + 大字町丁目名 + 緯度/経度 in one file — exactly the name join,
 * with no machiaza_id intermediary. Versions are published yearly with unknown
 * latest, so probe newest-first. License: 政府標準利用規約 (CC-BY-4.0
 * compatible), same open posture as the ABR (banked design, data-plan 07-22).
 */
export const MLIT_ISJ_VERSIONS = ["19.0b", "18.0b", "17.0b", "16.0b", "15.0b", "14.0b"];
export function mlitIsjUrl(version: string): string {
  return `https://nlftp.mlit.go.jp/isj/dls/data/${version}/13000-${version}.zip`;
}

/**
 * ABR CSV headers: the published files have used both Japanese and snake_case
 * English header rows across format revisions — both families are mapped, and
 * an unmapped file is skipped loudly (the CI log shows what we actually saw).
 */
const ABR_HEADERS = {
  lgCode: ["全国地方公共団体コード", "lg_code"],
  machiazaId: ["町字id", "町字ID", "machiaza_id"],
  lat: ["代表点_緯度", "rep_lat"],
  lng: ["代表点_経度", "rep_lon", "rep_lng"],
} as const;

/** Municipality half of the join key: digits only, leading zeros stripped; null when empty. */
export function lgKey(lgCode: string | null | undefined): string | null {
  const lg = (lgCode ?? "").replace(/\D/g, "").replace(/^0+/, "");
  return lg || null;
}

/**
 * Join key: digits only, leading zeros stripped on both sides so cosmetic
 * zero-padding differences between the ledger and ABR exports can't miss.
 * Returns null unless both parts carry digits — never joins on empty.
 */
export function abrKey(lgCode: string | null | undefined, machiazaId: string | null | undefined): string | null {
  const lg = lgKey(lgCode);
  const mz = (machiazaId ?? "").replace(/\D/g, "").replace(/^0+/, "");
  if (!lg || !mz) return null;
  return `${lg}:${mz}`;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/**
 * Minimal ZIP reader: central directory walk, stored (0) + deflate (8) entries.
 * Enough for single-CSV government archives; anything else fails loudly.
 */
export function extractZipEntries(buf: ArrayBuffer): ZipEntry[] {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  // End of central directory record: scan back for PK\x05\x06.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip: no end-of-central-directory record");
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("zip: bad central-directory entry");
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder("utf-8").decode(bytes.subarray(offset + 46, offset + 46 + nameLen));

    // Local header: name/extra lengths there can differ from the central copy.
    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error("zip: bad local-file header");
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);

    if (method === 0) entries.push({ name, data: raw.slice() });
    else if (method === 8) entries.push({ name, data: new Uint8Array(inflateRawSync(raw)) });
    else throw new Error(`zip: unsupported compression method ${method} for ${name}`);

    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** ZIP magic → concatenated CSV text of every .csv entry; otherwise decode as CSV directly. */
export function decodeCsvOrZip(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    const csvs = extractZipEntries(buf).filter((e) => /\.csv$/i.test(e.name));
    if (csvs.length === 0) throw new Error("zip: archive contains no .csv entry");
    return csvs
      .map((e) => decodeCsvBuffer(e.data.buffer.slice(e.data.byteOffset, e.data.byteOffset + e.data.byteLength) as ArrayBuffer))
      .join("\n");
  }
  return decodeCsvBuffer(buf);
}

export interface TownPosParseResult {
  index: Map<string, { lat: number; lng: number }>;
  skippedReason: string | null;
}

/** Parse a 位置参照拡張 CSV into the lgCode+町字ID → representative-point index. */
export function parseTownPosCsv(csvText: string): TownPosParseResult {
  const rows = parseCsv(csvText);
  if (rows.length < 2) return { index: new Map(), skippedReason: "empty or header-only file" };
  const header = rows[0];
  const lgI = headerIndex(header, ABR_HEADERS.lgCode);
  const mzI = headerIndex(header, ABR_HEADERS.machiazaId);
  const latI = headerIndex(header, ABR_HEADERS.lat);
  const lngI = headerIndex(header, ABR_HEADERS.lng);
  if (lgI < 0 || mzI < 0 || latI < 0 || lngI < 0) {
    return {
      index: new Map(),
      skippedReason: `unmapped ABR headers (saw: ${header.slice(0, 12).join("|")})`,
    };
  }
  const index = new Map<string, { lat: number; lng: number }>();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const key = abrKey(row[lgI], row[mzI]);
    if (!key) continue;
    const lat = Number.parseFloat((row[latI] ?? "").trim());
    const lng = Number.parseFloat((row[lngI] ?? "").trim());
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    index.set(key, { lat, lng });
  }
  return { index, skippedReason: null };
}

/**
 * Name-join fallback (run-#16 finding: the wards ship the 町字ID column EMPTY,
 * so the ID join alone geocodes zero rows). lg_code is present on 99.5% of
 * ledger rows and the address text always is — so: parse (town name, 丁目) out
 * of 所在地_連結表記, look the pair up in the ABR 町字マスター for that
 * municipality → machiaza_id → the same representative-point index as the ID
 * join. Same block precision, same fail-open posture.
 */
const ABR_TOWN_HEADERS = {
  lgCode: ["全国地方公共団体コード", "lg_code"],
  machiazaId: ["町字id", "町字ID", "machiaza_id"],
  oazaCho: ["大字・町名", "大字町名", "oaza_cho", "oaza_cho_name"],
  chome: ["丁目名", "chome", "chome_name"],
  koaza: ["小字名", "koaza", "koaza_name"],
} as const;

const KANJI_DIGIT: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/**
 * 丁目 numerals as published: arabic ("6") or kanji up to 99 ("六", "十二",
 * "二十三"). Anything else — including digit runs juxtaposed without 十 — is
 * null, never a guess.
 */
export function kanjiNumeral(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  if (/^\d+$/.test(t)) return Number.parseInt(t, 10);
  const m = /^([一二三四五六七八九])?(十)?([一二三四五六七八九])?$/.exec(t);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  if (!m[2]) return m[3] ? null : m[1] ? KANJI_DIGIT[m[1]] : null;
  return (m[1] ? KANJI_DIGIT[m[1]] : 1) * 10 + (m[3] ? KANJI_DIGIT[m[3]] : 0);
}

/**
 * Shared text normalization for the name join: NFKC (full-width digits →
 * ASCII), whitespace out, ヶ/ヵ folded to ケ (ledgers and ABR disagree on the
 * small-ke), kanji 丁目 numerals → arabic so "六丁目" and "6丁目" compare equal.
 */
export function townText(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[ヶヵ]/g, "ケ")
    .replace(/([一二三四五六七八九十]{1,3})丁目/g, (full, k: string) => {
      const n = kanjiNumeral(k);
      return n === null ? full : `${n}丁目`;
    });
}

/** lg → town name → 丁目 number (0 = no 丁目) → machiaza join key (`lg:mz`). */
export type TownNameIndex = Map<string, Map<string, Map<number, string>>>;

export interface TownNameParseResult {
  byLg: TownNameIndex;
  skippedReason: string | null;
}

/**
 * Parse a 町字マスター CSV into the per-municipality name lookup. Koaza
 * subdivisions are skipped (they'd collide with their parent town's name), and
 * a (lg, name, 丁目) pair that maps to two different machiaza_ids is dropped
 * outright — a wrong block is worse than an ungeocoded row.
 */
export function parseTownNameCsv(csvText: string): TownNameParseResult {
  const rows = parseCsv(csvText);
  if (rows.length < 2) return { byLg: new Map(), skippedReason: "empty or header-only file" };
  const header = rows[0];
  const lgI = headerIndex(header, ABR_TOWN_HEADERS.lgCode);
  const mzI = headerIndex(header, ABR_TOWN_HEADERS.machiazaId);
  const oazaI = headerIndex(header, ABR_TOWN_HEADERS.oazaCho);
  const chomeI = headerIndex(header, ABR_TOWN_HEADERS.chome);
  const koazaI = headerIndex(header, ABR_TOWN_HEADERS.koaza);
  if (lgI < 0 || mzI < 0 || oazaI < 0) {
    return {
      byLg: new Map(),
      skippedReason: `unmapped ABR town headers (saw: ${header.slice(0, 12).join("|")})`,
    };
  }
  const byLg: TownNameIndex = new Map();
  const dead = new Set<string>();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const key = abrKey(row[lgI], row[mzI]);
    if (!key) continue;
    if (koazaI >= 0 && (row[koazaI] ?? "").trim()) continue;
    const name = townText((row[oazaI] ?? "").trim());
    if (!name) continue;
    const chomeRaw = chomeI >= 0 ? (row[chomeI] ?? "").trim().replace(/丁目$/, "") : "";
    const chome = kanjiNumeral(chomeRaw) ?? 0;
    const lg = key.split(":")[0];
    const deadKey = `${lg}:${name}:${chome}`;
    if (dead.has(deadKey)) continue;
    let towns = byLg.get(lg);
    if (!towns) byLg.set(lg, (towns = new Map()));
    let chomes = towns.get(name);
    if (!chomes) towns.set(name, (chomes = new Map()));
    const existing = chomes.get(chome);
    if (existing !== undefined && existing !== key) {
      chomes.delete(chome);
      dead.add(deadKey);
      continue;
    }
    chomes.set(chome, key);
  }
  return { byLg, skippedReason: null };
}

/**
 * Resolve one ledger address against a municipality's town map. Every town
 * name is tried as a substring of the normalized address; a hit needs the
 * following digits to name a 丁目 that town actually has, or the town to be
 * 丁目-less (chome 0). Longest matching name wins (西新宿6丁目 must resolve to
 * 西新宿, not 新宿); an equal-length disagreement returns null — still
 * ambiguous, honestly.
 */
export function resolveTownBlock(towns: Map<string, Map<number, string>>, address: string): string | null {
  const addr = townText(address);
  let best: { len: number; mz: string } | null = null;
  let tie = false;
  for (const [name, chomes] of towns) {
    let resolved: string | null = null;
    let idx = addr.indexOf(name);
    let seen = idx >= 0;
    while (idx >= 0 && !resolved) {
      const m = /^(\d{1,3})/.exec(addr.slice(idx + name.length));
      if (m) {
        const hit = chomes.get(Number.parseInt(m[1], 10));
        if (hit) resolved = hit;
      }
      idx = addr.indexOf(name, idx + 1);
    }
    if (!resolved && seen) resolved = chomes.get(0) ?? null;
    if (!resolved) continue;
    if (!best || name.length > best.len) {
      best = { len: name.length, mz: resolved };
      tie = false;
    } else if (name.length === best.len && resolved !== best.mz) {
      tie = true;
    }
  }
  return best && !tie ? best.mz : null;
}

interface CkanPackage {
  title?: string;
  resources?: { url?: string; format?: string; name?: string }[];
}

/**
 * CKAN fallback: town-position packages for Tokyo (東京都 in the title, or a
 * pref13/13-prefixed municipality code in the resource name/url). CSV/ZIP only.
 */
export function selectTownPosResources(response: unknown): string[] {
  const results = (response as { result?: { results?: CkanPackage[] } })?.result?.results ?? [];
  const out: string[] = [];
  for (const pkg of results) {
    const title = pkg.title ?? "";
    if (!/位置参照拡張|町字.*位置/.test(title)) continue;
    for (const res of pkg.resources ?? []) {
      const format = (res.format ?? "").toUpperCase();
      if (format !== "CSV" && format !== "ZIP") continue;
      if (!res.url) continue;
      const scope = `${title} ${res.name ?? ""} ${res.url}`;
      if (/東京都|pref13|(?:^|[^0-9])13[01]\d{3}(?:[^0-9]|$)/.test(scope)) out.push(res.url);
    }
  }
  return [...new Set(out)];
}

/**
 * Node's fetch wraps the real network failure (ENOTFOUND / ETIMEDOUT / TLS)
 * in a bare "TypeError: fetch failed" — surface the cause chain, since it's
 * the only way a CI log can distinguish geo-blocking from DNS from timeout.
 */
export function errDetail(err: unknown): string {
  const parts = [String(err)];
  let cause = (err as { cause?: unknown })?.cause;
  for (let depth = 0; cause && depth < 3; depth++) {
    const code = (cause as { code?: string })?.code;
    parts.push(code ? `${String(cause)} [${code}]` : String(cause));
    cause = (cause as { cause?: unknown })?.cause;
  }
  return parts.join(" ← ");
}

async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url, {
    headers: { "user-agent": "mercantry-ingest/0.1" },
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.arrayBuffer();
}

/**
 * Build the Tokyo town-block index: well-known URL first, CKAN discovery as the
 * fallback. Throws (loudly, with what was tried) when no index can be built —
 * the caller degrades to ungeocode matching and says so in the run log.
 */
export async function fetchTokyoTownPosIndex(): Promise<Map<string, { lat: number; lng: number }>> {
  const attempts: string[] = [];
  try {
    const parsed = parseTownPosCsv(decodeCsvOrZip(await fetchBuffer(ABR_TOWN_POS_URL)));
    if (parsed.skippedReason) throw new Error(parsed.skippedReason);
    if (parsed.index.size > 0) return parsed.index;
    throw new Error("parsed but empty");
  } catch (err) {
    attempts.push(`${ABR_TOWN_POS_URL}: ${errDetail(err)}`);
  }

  let urls: string[] = [];
  for (const q of ABR_CKAN_QUERIES) {
    try {
      const res = await fetch(`${ABR_CKAN_SEARCH}?q=${encodeURIComponent(q)}&rows=100`, {
        headers: { "user-agent": "mercantry-ingest/0.1" },
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { result?: { results?: { title?: string }[] } };
      urls = selectTownPosResources(body);
      if (urls.length > 0) break;
      const titles = (body.result?.results ?? []).slice(0, 10).map((p) => p.title).join(" | ");
      attempts.push(`CKAN "${q}": no Tokyo town-pos resources (top titles: ${titles})`);
    } catch (err) {
      attempts.push(`CKAN "${q}": ${errDetail(err)}`);
    }
  }

  for (const url of urls.slice(0, 4)) {
    try {
      const parsed = parseTownPosCsv(decodeCsvOrZip(await fetchBuffer(url)));
      if (parsed.skippedReason) throw new Error(parsed.skippedReason);
      if (parsed.index.size > 0) return parsed.index;
      throw new Error("parsed but empty");
    } catch (err) {
      attempts.push(`${url}: ${errDetail(err)}`);
    }
  }
  throw new Error(`abr_town_pos: no usable town-position data. Tried:\n  ${attempts.join("\n  ")}`);
}

/**
 * CKAN fallback for the 町字マスター: master packages only (the 位置参照拡張
 * variant is excluded — that's the other index), Tokyo scope, CSV/ZIP only.
 */
export function selectTownMasterResources(response: unknown): string[] {
  const results = (response as { result?: { results?: CkanPackage[] } })?.result?.results ?? [];
  const out: string[] = [];
  for (const pkg of results) {
    const title = pkg.title ?? "";
    if (!/町字マスター/.test(title) || /位置参照/.test(title)) continue;
    for (const res of pkg.resources ?? []) {
      const format = (res.format ?? "").toUpperCase();
      if (format !== "CSV" && format !== "ZIP") continue;
      if (!res.url) continue;
      const scope = `${title} ${res.name ?? ""} ${res.url}`;
      if (/東京都|pref13|(?:^|[^0-9])13[01]\d{3}(?:[^0-9]|$)/.test(scope)) out.push(res.url);
    }
  }
  return [...new Set(out)];
}

/**
 * Build the Tokyo town-NAME index (町字マスター): well-known URL first, CKAN
 * discovery as the fallback. Throws with what was tried; the caller keeps the
 * ID-join results and logs the degradation.
 */
export async function fetchTokyoTownNameIndex(): Promise<TownNameIndex> {
  const attempts: string[] = [];
  try {
    const parsed = parseTownNameCsv(decodeCsvOrZip(await fetchBuffer(ABR_TOWN_URL)));
    if (parsed.skippedReason) throw new Error(parsed.skippedReason);
    if (parsed.byLg.size > 0) return parsed.byLg;
    throw new Error("parsed but empty");
  } catch (err) {
    attempts.push(`${ABR_TOWN_URL}: ${errDetail(err)}`);
  }

  let urls: string[] = [];
  for (const q of ABR_TOWN_CKAN_QUERIES) {
    try {
      const res = await fetch(`${ABR_CKAN_SEARCH}?q=${encodeURIComponent(q)}&rows=100`, {
        headers: { "user-agent": "mercantry-ingest/0.1" },
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { result?: { results?: { title?: string }[] } };
      urls = selectTownMasterResources(body);
      if (urls.length > 0) break;
      const titles = (body.result?.results ?? []).slice(0, 10).map((p) => p.title).join(" | ");
      attempts.push(`CKAN "${q}": no Tokyo town-master resources (top titles: ${titles})`);
    } catch (err) {
      attempts.push(`CKAN "${q}": ${errDetail(err)}`);
    }
  }

  for (const url of urls.slice(0, 4)) {
    try {
      const parsed = parseTownNameCsv(decodeCsvOrZip(await fetchBuffer(url)));
      if (parsed.skippedReason) throw new Error(parsed.skippedReason);
      if (parsed.byLg.size > 0) return parsed.byLg;
      throw new Error("parsed but empty");
    } catch (err) {
      attempts.push(`${url}: ${errDetail(err)}`);
    }
  }
  throw new Error(`abr_town: no usable town-master data. Tried:\n  ${attempts.join("\n  ")}`);
}

const MLIT_HEADERS = {
  cityCode: ["市区町村コード"],
  townName: ["大字町丁目名", "大字・町丁目名"],
  lat: ["緯度"],
  lng: ["経度"],
} as const;

export interface MlitTownParseResult {
  /** Same shapes the ABR path feeds applyTokyoGeocoding: names resolve to a synthesized key, the key resolves to a position. */
  byLg: TownNameIndex;
  posIndex: Map<string, { lat: number; lng: number }>;
  skippedReason: string | null;
}

/**
 * Parse an MLIT 位置参照情報 CSV. 大字町丁目名 folds town and 丁目 into one
 * string ("西新宿六丁目"), so split it with the same normalization the address
 * side gets. Keys are the 5-digit 市区町村コード (the ledgers' 6-digit lg_code
 * carries a trailing check digit — the lookup side falls back to the 5-digit
 * prefix). Ambiguous (name, 丁目) pairs are dropped, same rule as the ABR path.
 */
export function parseMlitTownCsv(csvText: string): MlitTownParseResult {
  const rows = parseCsv(csvText);
  if (rows.length < 2) return { byLg: new Map(), posIndex: new Map(), skippedReason: "empty or header-only file" };
  const header = rows[0];
  const cityI = headerIndex(header, MLIT_HEADERS.cityCode);
  const nameI = headerIndex(header, MLIT_HEADERS.townName);
  const latI = headerIndex(header, MLIT_HEADERS.lat);
  const lngI = headerIndex(header, MLIT_HEADERS.lng);
  if (cityI < 0 || nameI < 0 || latI < 0 || lngI < 0) {
    return {
      byLg: new Map(),
      posIndex: new Map(),
      skippedReason: `unmapped MLIT headers (saw: ${header.slice(0, 12).join("|")})`,
    };
  }
  const byLg: TownNameIndex = new Map();
  const posIndex = new Map<string, { lat: number; lng: number }>();
  const dead = new Set<string>();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const lg = lgKey(row[cityI]);
    if (!lg) continue;
    const full = townText((row[nameI] ?? "").trim());
    if (!full || full === townText(MLIT_HEADERS.townName[0])) continue; // concatenated-zip header rows
    const lat = Number.parseFloat((row[latI] ?? "").trim());
    const lng = Number.parseFloat((row[lngI] ?? "").trim());
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const m = /^(.+?)(\d{1,3})丁目$/.exec(full);
    const name = m ? m[1] : full;
    const chome = m ? Number.parseInt(m[2], 10) : 0;
    const deadKey = `${lg}:${name}:${chome}`;
    if (dead.has(deadKey)) continue;
    const key = `${lg}:isj:${name}:${chome}`;
    let towns = byLg.get(lg);
    if (!towns) byLg.set(lg, (towns = new Map()));
    let chomes = towns.get(name);
    if (!chomes) towns.set(name, (chomes = new Map()));
    // The synthesized key is name-derived, so a duplicate (name, 丁目) pair
    // collides on the key itself — disagreeing coordinates are the ambiguity.
    const prev = posIndex.get(key);
    if (prev && (prev.lat !== lat || prev.lng !== lng)) {
      chomes.delete(chome);
      posIndex.delete(key);
      dead.add(deadKey);
      continue;
    }
    chomes.set(chome, key);
    posIndex.set(key, { lat, lng });
  }
  return { byLg, posIndex, skippedReason: null };
}

/** Probe MLIT 位置参照情報 releases newest-first; first parseable Tokyo file wins. */
export async function fetchMlitTownIndex(): Promise<{ byLg: TownNameIndex; posIndex: Map<string, { lat: number; lng: number }> }> {
  const attempts: string[] = [];
  for (const version of MLIT_ISJ_VERSIONS) {
    const url = mlitIsjUrl(version);
    try {
      const parsed = parseMlitTownCsv(decodeCsvOrZip(await fetchBuffer(url)));
      if (parsed.skippedReason) throw new Error(parsed.skippedReason);
      if (parsed.byLg.size > 0) return { byLg: parsed.byLg, posIndex: parsed.posIndex };
      throw new Error("parsed but empty");
    } catch (err) {
      attempts.push(`${url}: ${errDetail(err)}`);
    }
  }
  throw new Error(`mlit_isj: no usable 位置参照情報 release. Tried:\n  ${attempts.join("\n  ")}`);
}
