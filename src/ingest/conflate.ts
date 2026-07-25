/**
 * Entity resolution: dedupe geo-bearing base records, then anchor
 * official-register rows onto them (existence confirmation + local names).
 * Merge rules favor completeness, never invent data.
 */
import type { AgreementRate, AliasEnrichmentStats, CityConfig, OfficialRecord, ProvenanceEntry, ReleaseMerchant, StagedPlace } from "./types.js";
import type { WikidataPlace } from "./connectors/wikidata.js";
import { addressesMatch, gridKey, haversineKm, namesMatch, neighborKeys, normalizeName, stableMerchantId } from "./normalize.js";

const DUP_DISTANCE_KM = 0.15;
/** Official rows with coordinates can anchor a bit farther out — registers geocode to parcel centroids. */
const OFFICIAL_MATCH_KM = 0.5;

export interface ConflatedPlace extends StagedPlace {
  merged_refs: StagedPlace["ref"][];
  official: OfficialRecord[];
  /** Wikidata matches, with the aliases each one actually contributed. */
  wikidata: { ref: StagedPlace["ref"]; added: string[] }[];
}

/**
 * Agreement counters (manifest.source_agreement). Counted where the two
 * assertions meet — inside the merge/match step, before any backfill mutates
 * either side — so a copied value can never inflate agreement.
 */
export interface AgreementCounter {
  compared: number;
  agreed: number;
}
export interface DedupeAgreement {
  phone: AgreementCounter;
  website: AgreementCounter;
}
export interface OfficialAgreement {
  address: AgreementCounter;
  geo_within_150m: AgreementCounter;
}
export const freshDedupeAgreement = (): DedupeAgreement => ({ phone: { compared: 0, agreed: 0 }, website: { compared: 0, agreed: 0 } });
export const freshOfficialAgreement = (): OfficialAgreement => ({ address: { compared: 0, agreed: 0 }, geo_within_150m: { compared: 0, agreed: 0 } });

export function agreementRate(c: AgreementCounter): AgreementRate {
  return { ...c, rate: c.compared > 0 ? Math.round((c.agreed / c.compared) * 1000) / 1000 : null };
}

/** Protocol/www/trailing-slash variance isn't disagreement about the venue's site. */
function websiteKey(url: string): string {
  return url.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
}

/** Same name within ~150 m → one place. Higher-confidence record wins field conflicts. */
export function dedupeStaged(places: StagedPlace[], agreement?: DedupeAgreement): ConflatedPlace[] {
  const buckets = new Map<string, ConflatedPlace[]>();
  const out: ConflatedPlace[] = [];

  for (const place of [...places].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))) {
    let merged = false;
    for (const key of neighborKeys(place.lat, place.lng)) {
      for (const existing of buckets.get(key) ?? []) {
        if (
          haversineKm(place.lat, place.lng, existing.lat, existing.lng) <= DUP_DISTANCE_KM &&
          namesMatch(place.name, existing.name)
        ) {
          mergeInto(existing, place, agreement);
          merged = true;
          break;
        }
      }
      if (merged) break;
    }
    if (!merged) {
      const entry: ConflatedPlace = { ...place, merged_refs: [place.ref], official: [], wikidata: [] };
      out.push(entry);
      const key = gridKey(place.lat, place.lng);
      buckets.set(key, [...(buckets.get(key) ?? []), entry]);
    }
  }
  return out;
}

function mergeInto(primary: ConflatedPlace, dup: StagedPlace, agreement?: DedupeAgreement) {
  if (agreement) {
    if (primary.phone && dup.phone) {
      agreement.phone.compared++;
      if (primary.phone === dup.phone) agreement.phone.agreed++;
    }
    if (primary.website && dup.website) {
      agreement.website.compared++;
      if (websiteKey(primary.website) === websiteKey(dup.website)) agreement.website.agreed++;
    }
  }
  primary.merged_refs.push(dup.ref);
  primary.phone ??= dup.phone;
  primary.website ??= dup.website;
  if (!primary.address) primary.address = dup.address;
  if (!primary.neighborhood) primary.neighborhood = dup.neighborhood;
  primary.aliases = [...new Set([...primary.aliases, ...dup.aliases, ...(dup.name !== primary.name ? [dup.name] : [])])];
  primary.cuisine_tags = [...new Set([...primary.cuisine_tags, ...dup.cuisine_tags])];
}

export interface CrosscheckStats {
  matched: number;
  ambiguous: number;
  unmatched: number;
}

/**
 * Anchor official rows to conflated places by name (plus distance when the
 * register has coordinates). Only unique matches enrich — an ambiguous match
 * is worse than none, so those are counted and skipped.
 */
export function enrichWithOfficial(places: ConflatedPlace[], official: OfficialRecord[], agreement?: OfficialAgreement): CrosscheckStats {
  const byName = new Map<string, ConflatedPlace[]>();
  for (const place of places) {
    const key = normalizeName(place.name);
    byName.set(key, [...(byName.get(key) ?? []), place]);
  }

  const stats: CrosscheckStats = { matched: 0, ambiguous: 0, unmatched: 0 };
  for (const rec of official) {
    let candidates = byName.get(normalizeName(rec.name)) ?? [];
    if (candidates.length === 0) {
      stats.unmatched++;
      continue;
    }
    if (rec.lat != null && rec.lng != null) {
      const near = candidates.filter((p) => haversineKm(p.lat, p.lng, rec.lat!, rec.lng!) <= OFFICIAL_MATCH_KM);
      if (near.length > 0) candidates = near;
    }
    if (candidates.length > 1) {
      // Chains: same name, many branches. The register's address is the
      // distinguishing evidence (run #3: HK ambiguous = 2,797, mostly chains).
      const byAddress = candidates.filter((p) => addressesMatch(rec.address, p.address));
      if (byAddress.length === 1) {
        candidates = byAddress;
      } else {
        stats.ambiguous++;
        continue;
      }
    }
    const place = candidates[0];
    if (agreement) {
      if (rec.address && place.address) {
        agreement.address.compared++;
        if (addressesMatch(rec.address, place.address)) agreement.address.agreed++;
      }
      if (rec.lat != null && rec.lng != null) {
        agreement.geo_within_150m.compared++;
        if (haversineKm(place.lat, place.lng, rec.lat, rec.lng) <= DUP_DISTANCE_KM) agreement.geo_within_150m.agreed++;
      }
    }
    place.official.push(rec);
    if (rec.name_local && !place.aliases.includes(rec.name_local)) place.aliases.push(rec.name_local);
    if (!place.neighborhood && rec.district) place.neighborhood = rec.district;
    if (!place.address && rec.address) place.address = rec.address;
    stats.matched++;
  }
  return stats;
}

/**
 * Anchor Wikidata restaurant items to conflated places and add their
 * local-language labels/aliases. Same conservatism as the register join:
 * name match (en label OR any local label, against the place's name AND
 * aliases — register enrichment runs first, so its aliases are match keys
 * here) + geo within OFFICIAL_MATCH_KM, unique matches only. A wrong alias on
 * the wrong branch is worse than a missing one.
 */
export function enrichWithWikidata(places: ConflatedPlace[], items: WikidataPlace[]): AliasEnrichmentStats {
  const byName = new Map<string, ConflatedPlace[]>();
  const index = (key: string, place: ConflatedPlace) => {
    if (!key) return;
    const list = byName.get(key) ?? [];
    if (!list.includes(place)) byName.set(key, [...list, place]);
  };
  for (const place of places) {
    index(normalizeName(place.name), place);
    for (const alias of place.aliases) index(normalizeName(alias), place);
  }

  const stats: AliasEnrichmentStats = { matched: 0, ambiguous: 0, unmatched: 0, aliases_added: 0 };
  for (const item of items) {
    const candidates = new Set<ConflatedPlace>();
    for (const name of [item.name_en, ...item.names_local]) {
      if (!name) continue;
      for (const place of byName.get(normalizeName(name)) ?? []) candidates.add(place);
    }
    const near = [...candidates].filter((p) => haversineKm(p.lat, p.lng, item.lat, item.lng) <= OFFICIAL_MATCH_KM);
    if (near.length === 0) {
      stats.unmatched++;
      continue;
    }
    if (near.length > 1) {
      stats.ambiguous++;
      continue;
    }
    const place = near[0];
    const added = item.names_local.filter((n) => n !== place.name && !place.aliases.includes(n));
    place.aliases.push(...added);
    place.wikidata.push({ ref: item.ref, added });
    stats.matched++;
    stats.aliases_added += added.length;
  }
  return stats;
}

/** Fields carried as schema defaults with no source behind them (declared in the manifest). */
export const UNSOURCED_DEFAULTS = ["price_band", "reservation_policy", "max_party_size", "fulfillment_channel"];

export function toReleaseMerchants(city: CityConfig, places: ConflatedPlace[]): ReleaseMerchant[] {
  const merchants = places.map((place): ReleaseMerchant => {
    const provenance: ProvenanceEntry[] = [];
    const provTargets: [string, boolean][] = [
      ["name", true],
      ["location", true],
      ["cuisine_tags", place.cuisine_tags.length > 0],
      ["phone_primary", place.phone != null],
      ["website", place.website != null],
    ];
    for (const ref of place.merged_refs) {
      for (const [field, present] of provTargets) {
        if (present) {
          provenance.push({
            field,
            source: ref.source,
            detail: `${ref.detail} (id: ${ref.source_id})`,
            // Each ref keeps its own retrieval time — merged sources may have
            // been fetched at different times (e.g. FSQ OS in P1).
            recorded_at: ref.retrieved_at,
          });
        }
      }
    }
    for (const rec of place.official) {
      provenance.push({
        field: "name",
        source: rec.ref.source,
        detail: `${rec.ref.detail} (id: ${rec.ref.source_id})`,
        recorded_at: rec.ref.retrieved_at,
      });
      if (rec.name_local) {
        provenance.push({
          field: "aliases",
          source: rec.ref.source,
          detail: `local-language name from official register (id: ${rec.ref.source_id})`,
          recorded_at: rec.ref.retrieved_at,
        });
      }
    }
    for (const wd of place.wikidata) {
      if (wd.added.length === 0) continue;
      provenance.push({
        field: "aliases",
        source: wd.ref.source,
        detail: `local-language name from Wikidata (id: ${wd.ref.source_id})`,
        recorded_at: wd.ref.retrieved_at,
      });
    }

    return {
      merchant_id: stableMerchantId(city.key, place.name, place.lat, place.lng),
      name: place.name,
      aliases: place.aliases,
      category: "restaurant",
      cuisine_tags: place.cuisine_tags.sort(),
      attribute_tags: [],
      location: {
        address: place.address,
        neighborhood: place.neighborhood,
        city: city.city,
        lat: place.lat,
        lng: place.lng,
      },
      timezone: city.timezone,
      phone_primary: place.phone,
      phone_verified_at: null,
      hours: [],
      holiday_exceptions: [],
      price_band: 2,
      reservation_policy: "accepts_reservations",
      requires_deposit: false,
      bookable: false,
      fulfillment_channel: "voice_agent",
      website: place.website,
      languages: [],
      verification_status: "unverified",
      opt_out: false,
      max_party_size: 8,
      source_provenance: provenance,
    };
  });
  // Deterministic corpus order (agent-readability: stable diffs between releases).
  return merchants.sort((a, b) => a.merchant_id.localeCompare(b.merchant_id));
}
