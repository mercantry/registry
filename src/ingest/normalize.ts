import { createHash } from "node:crypto";
import type { CityConfig } from "./types.js";

/**
 * Name normalization for matching/dedup. NFKC first so full-width CJK
 * punctuation and half-width kana compare equal; no tokenization assumptions
 * so CJK names survive intact.
 */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^the /, "");
}

export function nameTokens(name: string): string[] {
  return normalizeName(name).split(" ").filter(Boolean);
}

/** Match rule: exact after normalization, containment (CJK-friendly), or token Jaccard ≥ 0.6. */
export function namesMatch(a: string, b: string): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 3 && nb.length >= 3 && (na.includes(nb) || nb.includes(na))) return true;
  const ta = new Set(nameTokens(a));
  const tb = new Set(nameTokens(b));
  if (ta.size === 0 || tb.size === 0) return false;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter) >= 0.6;
}

/**
 * Phone → E.164 for the three launch-coverage countries. Returns null on
 * anything that doesn't normalize cleanly — a wrong phone is worse than an
 * absent one (bad_data poisons booking calls, REQ-ING-3).
 */
export function toE164(raw: string | null | undefined, country: CityConfig["country"]): string | null {
  if (!raw) return null;
  let digits = raw.normalize("NFKC").replace(/[^\d+]/g, "");
  if (digits.startsWith("00")) digits = `+${digits.slice(2)}`;
  const hasPlus = digits.startsWith("+");
  digits = digits.replace(/\D/g, "");

  if (country === "US") {
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    if (digits.length === 10 && !hasPlus) return `+1${digits}`;
  }
  if (country === "JP") {
    if (hasPlus && digits.startsWith("81") && digits.length >= 11 && digits.length <= 12) return `+${digits}`;
    if (!hasPlus && digits.startsWith("0") && (digits.length === 10 || digits.length === 11)) return `+81${digits.slice(1)}`;
  }
  if (country === "HK") {
    if (hasPlus && digits.startsWith("852") && digits.length === 11) return `+${digits}`;
    if (!hasPlus && digits.length === 8) return `+852${digits}`;
  }
  return null;
}

export const E164_RE = /^\+\d{8,15}$/;

/**
 * The served-corpus address bar (shared by the connector drop rule and the QA
 * gate's expectation): a locatable street address carries a number token, or is
 * CJK (Japanese/Chinese addresses are block-based and legitimately numberless
 * in freeform, e.g. mall/building names). Street-only Latin addresses
 * ("Cameron Rd") aren't precise enough to book or verify against.
 */
export function isLocatableAddress(address: string): boolean {
  const a = address.trim();
  if (!a) return false;
  return /\d/.test(a) || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(a);
}

export function inBbox(lat: number, lng: number, bbox: CityConfig["bbox"]): boolean {
  return lat >= bbox.south && lat <= bbox.north && lng >= bbox.west && lng <= bbox.east;
}

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

/** ~150 m grid cell key for conflation bucketing; check the 8 neighbors too. */
const GRID = 0.0015;
export function gridKey(lat: number, lng: number): string {
  return `${Math.round(lat / GRID)}:${Math.round(lng / GRID)}`;
}
export function neighborKeys(lat: number, lng: number): string[] {
  const r = Math.round(lat / GRID);
  const c = Math.round(lng / GRID);
  const keys: string[] = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) keys.push(`${r + dr}:${c + dc}`);
  return keys;
}

/**
 * Deterministic merchant_id (UUID-shaped, sha256-derived) so IDs are stable
 * across releases (agent-readability principle: stable IDs, cacheable corpus).
 * Geo is rounded to ~110 m for the key so small source jitter doesn't mint a
 * new identity; a real move or rename intentionally does.
 */
export function stableMerchantId(cityKey: string, name: string, lat: number, lng: number): string {
  const basis = `${cityKey}|${normalizeName(name)}|${lat.toFixed(3)}|${lng.toFixed(3)}`;
  const h = createHash("sha256").update(basis).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const GENERIC_CATEGORY_TOKENS = new Set(["restaurant", "eat_and_drink", "food", ""]);

/**
 * Overture category → cuisine tag: "japanese_restaurant" → "japanese".
 * Raw signal passthrough (REQ-DATA-2: tags, never opinions); generic tokens dropped.
 */
export function cuisineFromCategory(category: string | null | undefined): string | null {
  if (!category) return null;
  const tag = category.toLowerCase().replace(/_restaurant$/, "").trim();
  return GENERIC_CATEGORY_TOKENS.has(tag) ? null : tag;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const ADDRESS_ABBREV: Record<string, string> = {
  street: "st", road: "rd", avenue: "ave", boulevard: "blvd", drive: "dr",
  lane: "ln", terrace: "ter", building: "bldg", floor: "fl", ground: "g",
  north: "n", south: "s", east: "e", west: "w",
};
const ADDRESS_STOPWORDS = new Set(["the", "of", "no", "at", "and", "&"]);

/**
 * Japanese block addresses (丁目/番/号) as ONE canonical strong token, so
 * register↔place matching works across formats: "西新宿6丁目6-2",
 * "6 Chome-6-2 Nishishinjuku" and "6丁目6番2号" all yield "c6-6-2".
 * Deliberately NOT naive digit-splitting — two different addresses sharing
 * loose digits ("6", "2") must never count as address evidence.
 */
const JP_BLOCK_RE = /(\d+)\s*(?:丁目|chome)\s*[-]?\s*(\d+)(?:\s*(?:番|[-])\s*(\d+))?\s*(?:号)?/giu;

export function blockAddressTokens(normalized: string): string[] {
  const out: string[] = [];
  for (const m of normalized.matchAll(JP_BLOCK_RE)) {
    out.push(m[3] ? `c${m[1]}-${m[2]}-${m[3]}` : `c${m[1]}-${m[2]}`);
  }
  return out;
}

/**
 * Address tokens for register↔place disambiguation (chains share a name; the
 * address is what distinguishes branches). NFKC + lowercase + abbreviation
 * folding so "8 FINANCE STREET, CENTRAL" and "8 Finance St" share {8,finance,st}.
 * CJK block sequences additionally emit their canonical token (see above).
 */
export function addressTokens(address: string | null | undefined): Set<string> {
  if (!address) return new Set();
  const normalized = address.normalize("NFKC").toLowerCase();
  // Fold digit-adjacent dash variants (hyphen family, minus, katakana chōonpu
  // used as a dash in the wild) to ASCII "-" so block sequences survive; only
  // next to digits, so chōonpu inside kana street names is untouched.
  const dashFolded = normalized.replace(/(?<=\d)[‐-―−ー]|[‐-―−ー](?=\d)/g, "-");
  const tokens = dashFolded
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .split(/\s+/)
    .filter((t) => t && !ADDRESS_STOPWORDS.has(t))
    .map((t) => ADDRESS_ABBREV[t] ?? t);
  return new Set([...tokens, ...blockAddressTokens(dashFolded)]);
}

/**
 * True when two addresses plausibly refer to the same premises: at least two
 * shared tokens, one of which carries a digit (street/lot number) — OR one
 * shared full 3-part block token (c丁目-番-号), which is specific enough to
 * stand alone and is the only evidence available when the two sides are in
 * different scripts ("西新宿6丁目6-2" vs "6 Chome-6-2 Nishishinjuku").
 * Two-part blocks stay too weak to stand alone. Weaker overlap is treated as
 * no evidence — a wrong branch match poisons the licence join, so this errs
 * toward "still ambiguous".
 */
export function addressesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const ta = addressTokens(a);
  if (ta.size === 0) return false;
  const tb = addressTokens(b);
  let shared = 0;
  let sharedNumeric = false;
  for (const t of ta) {
    if (tb.has(t)) {
      shared++;
      if (/\d/.test(t)) sharedNumeric = true;
      if (/^c\d+-\d+-\d+$/.test(t)) return true;
    }
  }
  return shared >= 2 && sharedNumeric;
}
