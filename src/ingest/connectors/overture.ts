/**
 * Overture Maps places connector — the global base layer for all coverage cities.
 * License: CDLA-Permissive-2.0 (storable, redistributable).
 *
 * Input is GeoJSONSeq (one feature per line, RFC 8142) produced in CI by the
 * `overturemaps` CLI with a city bbox — a whole-city places extract is too big
 * to JSON.parse in one buffer, so this connector streams line by line.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { CityConfig, StagedPlace } from "./../types.js";
import { cleanNeighborhoodLabel, cuisineFromCategory, inBbox, isDeniedPrimaryCategory, isLocatableAddress, matchesAdminExclude, toE164 } from "./../normalize.js";

const OVERTURE_DETAIL = "overturemaps.org places theme, bbox extract via overturemaps CLI";

interface OvertureProps {
  id?: string;
  names?: { primary?: string; common?: Record<string, string> | null };
  /** Some Overture releases surface common names at the top level instead of under names. */
  common?: Record<string, string> | null;
  categories?: { primary?: string; alternate?: string[] };
  confidence?: number;
  phones?: string[];
  websites?: string[];
  addresses?: { freeform?: string; locality?: string; district?: string; region?: string; country?: string }[];
}

export interface OvertureDropCounts {
  non_restaurant: number;
  denied_category: number;
  unnamed: number;
  no_geometry: number;
  out_of_bbox: number;
  out_of_admin: number;
  no_address: number;
  invalid_phone: number;
}

/**
 * country/region distributions of kept vs admin-dropped records — a run-log
 * diagnostic (header-alignment-dump precedent): if Overture encodes the
 * metadata differently than the exclude rules assume, the kept-side
 * distribution shows it instead of the filter silently no-opping.
 */
export interface AdminFilterStats {
  kept: Map<string, number>;
  dropped: Map<string, number>;
}

/**
 * Primary-category distributions around the deny-list — same read-before-trust
 * diagnostic as AdminFilterStats: `denied` shows what the list actually fires
 * on; `kept_non_restaurant_primary` is the residual risk pool (records kept
 * with a primary that names something other than a restaurant), so remaining
 * noise classes surface in the run log instead of in a QA sample.
 */
export interface CategoryFilterStats {
  denied: Map<string, number>;
  kept_non_restaurant_primary: Map<string, number>;
}

function bumpAdminStat(map: Map<string, number>, addr: { region?: string; country?: string } | undefined) {
  const key = `${addr?.country?.trim() || "?"}/${addr?.region?.trim() || "?"}`;
  map.set(key, (map.get(key) ?? 0) + 1);
}

function isRestaurant(props: OvertureProps): boolean {
  const cats = [props.categories?.primary ?? "", ...(props.categories?.alternate ?? [])];
  return cats.some((c) => c.toLowerCase().includes("restaurant"));
}

/** Parse one GeoJSONSeq line; null = not a restaurant record we keep (counted in drops). */
export function parseOvertureFeatureLine(
  line: string,
  city: CityConfig,
  retrievedAt: string,
  drops: OvertureDropCounts,
  adminStats?: AdminFilterStats,
  catStats?: CategoryFilterStats,
): StagedPlace | null {
  const trimmed = line.replace(/^\x1e/, "").trim(); // RFC 8142 record separator
  if (!trimmed) return null;
  const feature = JSON.parse(trimmed) as {
    geometry?: { type?: string; coordinates?: [number, number] };
    properties?: OvertureProps;
  };
  const props = feature.properties ?? {};
  if (!isRestaurant(props)) {
    drops.non_restaurant++;
    return null;
  }
  // isRestaurant accepts on ANY category naming a restaurant — including
  // alternates on records whose primary says massage/clinic/school/hotel
  // (SH run #14 noise). The primary wins when it affirmatively names a
  // non-venue class; absent/unrecognized primaries keep the record.
  const primaryCategory = props.categories?.primary?.trim().toLowerCase() ?? "";
  if (isDeniedPrimaryCategory(primaryCategory)) {
    drops.denied_category++;
    if (catStats) catStats.denied.set(primaryCategory, (catStats.denied.get(primaryCategory) ?? 0) + 1);
    return null;
  }
  if (catStats && primaryCategory && !primaryCategory.includes("restaurant")) {
    catStats.kept_non_restaurant_primary.set(primaryCategory, (catStats.kept_non_restaurant_primary.get(primaryCategory) ?? 0) + 1);
  }
  const name = props.names?.primary?.trim();
  if (!name) {
    drops.unnamed++;
    return null;
  }
  const coords = feature.geometry?.coordinates;
  if (!coords || feature.geometry?.type !== "Point") {
    drops.no_geometry++;
    return null;
  }
  const [lng, lat] = coords;
  if (!inBbox(lat, lng, city.bbox)) {
    drops.out_of_bbox++;
    return null;
  }

  const addr0 = props.addresses?.[0];
  if (city.adminExclude?.length) {
    if (matchesAdminExclude(addr0?.country, addr0?.region, city.adminExclude)) {
      drops.out_of_admin++;
      if (adminStats) bumpAdminStat(adminStats.dropped, addr0);
      return null;
    }
    if (adminStats) bumpAdminStat(adminStats.kept, addr0);
  }

  // Runs #6/#7 QA gate findings: empty addresses, then street-only Latin
  // addresses ("Cameron Rd") — both below the served-corpus bar. The connector
  // enforces the same isLocatableAddress predicate the QA gate expects, so a
  // release can't carry records its own QA would call malformed.
  const addr = addr0;
  if (!isLocatableAddress(addr?.freeform ?? "")) {
    drops.no_address++;
    return null;
  }

  const phoneRaw = props.phones?.[0] ?? null;
  const phone = toE164(phoneRaw, city.country);
  if (phoneRaw && !phone) drops.invalid_phone++;

  const aliases = Object.values(props.common ?? props.names?.common ?? {})
    .filter((v): v is string => typeof v === "string" && v.trim() !== "" && v.trim() !== name)
    .map((v) => v.trim());

  const cuisineSet = new Set<string>();
  for (const cat of [props.categories?.primary, ...(props.categories?.alternate ?? [])]) {
    const tag = cuisineFromCategory(cat);
    if (tag) cuisineSet.add(tag);
    if (cuisineSet.size >= 3) break;
  }

  // Overture "locality" is usually the city itself, and for Shanghai so is
  // "district" (上海市) — both fields pass through label hygiene, and a junk
  // district falls back to the locality instead of shadowing it.
  const neighborhood =
    cleanNeighborhoodLabel(addr?.district, city) || cleanNeighborhoodLabel(addr?.locality, city);

  return {
    ref: {
      source: "overture",
      source_id: props.id ?? `${lat},${lng}:${name}`,
      detail: OVERTURE_DETAIL,
      retrieved_at: retrievedAt,
    },
    name,
    aliases: [...new Set(aliases)],
    cuisine_tags: [...cuisineSet],
    address: addr?.freeform?.trim() ?? "",
    neighborhood,
    lat,
    lng,
    phone,
    website: props.websites?.[0]?.trim() ?? null,
    confidence: typeof props.confidence === "number" ? props.confidence : null,
  };
}

export async function loadOverture(
  path: string,
  city: CityConfig,
  retrievedAt: string,
): Promise<{ places: StagedPlace[]; drops: OvertureDropCounts }> {
  const drops: OvertureDropCounts = { non_restaurant: 0, denied_category: 0, unnamed: 0, no_geometry: 0, out_of_bbox: 0, out_of_admin: 0, no_address: 0, invalid_phone: 0 };
  const places: StagedPlace[] = [];
  const adminStats: AdminFilterStats = { kept: new Map(), dropped: new Map() };
  const catStats: CategoryFilterStats = { denied: new Map(), kept_non_restaurant_primary: new Map() };
  const rl = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    const place = parseOvertureFeatureLine(line, city, retrievedAt, drops, adminStats, catStats);
    if (place) places.push(place);
  }
  const fmt = (m: Map<string, number>, top = Infinity) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, n]) => `${k}:${n}`).join(" ") || "(none)";
  if (city.adminExclude?.length) {
    console.log(`[${city.key}] admin filter country/region — dropped ${fmt(adminStats.dropped)} · kept ${fmt(adminStats.kept)}`);
  }
  console.log(`[${city.key}] category deny-list — denied ${fmt(catStats.denied)}`);
  console.log(`[${city.key}] kept non-restaurant primaries (top 25) — ${fmt(catStats.kept_non_restaurant_primary, 25)}`);
  return { places, drops };
}
