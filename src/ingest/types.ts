/**
 * Ingestion pipeline types (REQ-ING-1: real sources, per-field provenance).
 *
 * Two record kinds flow through the pipeline:
 *  - StagedPlace: geo-bearing base records (Overture Maps; later FSQ OS Places).
 *  - OfficialRecord: rows from a government business/license register. These may
 *    lack coordinates, so they never create standalone merchants in P0 — they
 *    confirm existence, add local-language names, and carry official provenance.
 *
 * Standing rule (pre-counsel): openly licensed
 * sources only. Every connector declares its license in SOURCE_LICENSES.
 */

export type CityKey = "la" | "tokyo" | "hk" | "sh";

export interface CityConfig {
  key: CityKey;
  /** Canonical display value stored in merchants.city. */
  city: string;
  country: "US" | "JP" | "HK" | "CN";
  timezone: string;
  /** Ingestion extent; also the validation bound for record coordinates. */
  bbox: { west: number; south: number; east: number; north: number };
  /** Official-register connectors wired for this city (keys into connectors/). */
  officialSources: string[];
  /**
   * Admin-boundary spillover filter: a bbox is a rectangle and rectangles cross
   * jurisdictions (the HK bbox reaches Shenzhen, the Tokyo bbox reaches
   * Kanagawa/Saitama/Chiba). A record is dropped ONLY when Overture's own
   * address metadata AFFIRMATIVELY matches an exclude rule (country and/or
   * ISO 3166-2 region); absent or unrecognized metadata always keeps the
   * record — no false drops, spillover removal is honest-best-effort. Uses
   * fields already in the CDLA-P places extract: no new source, no boundary
   * polygons (Overture's divisions theme is ODbL — excluded until D2).
   */
  adminExclude?: { country?: string; region?: string }[];
  /**
   * Language tags for Wikidata label/alias enrichment (empty = skip the
   * connector — LA needs no local-name layer).
   */
  wikidataLanguages: string[];
}

export interface SourceRef {
  /** Connector key, e.g. "overture" | "fehd_hk" | "la_open_data". */
  source: string;
  /** Stable id within the source (Overture GERS id, license number, account id). */
  source_id: string;
  /** URL or dataset reference for the provenance trail. */
  detail: string;
  retrieved_at: string;
}

export interface StagedPlace {
  ref: SourceRef;
  name: string;
  /** Other-language / alternate names keyed by BCP-47 tag where known. */
  aliases: string[];
  cuisine_tags: string[];
  address: string;
  neighborhood: string;
  lat: number;
  lng: number;
  phone: string | null;
  website: string | null;
  /** Source-asserted existence confidence (Overture), 0..1 when present. */
  confidence: number | null;
}

export interface OfficialRecord {
  ref: SourceRef;
  name: string;
  /** Local-language name when the register is bilingual (e.g. FEHD Chinese name). */
  name_local: string | null;
  district: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
}

export interface ProvenanceEntry {
  field: string;
  source: string;
  detail: string;
  recorded_at: string;
}

/**
 * One line of merchants.ndjson. Mirrors the registry Merchant shape so the
 * import step is a mapping, not a transformation. bookable is always false and
 * verification_status "unverified" at ingest — only a verification pass
 * (REQ-ING-2) upgrades them. Fields listed in manifest.unsourced_defaults are
 * schema defaults with no source behind them; absent data stays absent.
 */
export interface ReleaseMerchant {
  merchant_id: string;
  name: string;
  aliases: string[];
  category: "restaurant";
  cuisine_tags: string[];
  attribute_tags: string[];
  location: { address: string; neighborhood: string; city: string; lat: number; lng: number };
  /** IANA timezone from the city config — the per-merchant tz source for booking datetimes and call windows (multi-city breaks the global LAUNCH_TZ; see the REQ-FUL-5 flag). */
  timezone: string;
  phone_primary: string | null;
  phone_verified_at: null;
  hours: [];
  holiday_exceptions: [];
  price_band: number;
  reservation_policy: "accepts_reservations";
  requires_deposit: false;
  bookable: false;
  fulfillment_channel: "voice_agent";
  /** Not yet a registry column — release carries it so the data isn't lost; import maps it when @eng adds the column. */
  website: string | null;
  languages: string[];
  verification_status: "unverified";
  opt_out: false;
  max_party_size: number;
  source_provenance: ProvenanceEntry[];
}

/**
 * Alias (local-name) enrichment outcome — reported separately from
 * official_crosscheck because Wikidata is NOT a government register: it
 * corroborates existence but never counts as register evidence in QA.
 */
export interface AliasEnrichmentStats {
  matched: number;
  ambiguous: number;
  unmatched: number;
  aliases_added: number;
}

export interface SourceStats {
  source: string;
  license: string;
  detail: string;
  records: number;
  retrieved_at: string;
}

export interface FieldCoverage {
  phone: number;
  website: number;
  neighborhood: number;
  cuisine: number;
  /** Records with a non-ASCII alias (a local name IN ADDITION to the primary). */
  local_alias: number;
  /** Records with any non-ASCII name at all (primary or alias) — the honest
   * "agent can address this merchant in the local language" measure; in Tokyo
   * many primaries are already Japanese, which local_alias alone misses. */
  local_name: number;
}

export interface ReleaseManifest {
  release: string;
  city: string;
  city_key: CityKey;
  generated_at: string;
  merchant_count: number;
  sources: SourceStats[];
  /** Fraction (0..1) of merchants with the field populated. */
  field_coverage: FieldCoverage;
  /** Official-register cross-check: how much of the register we could anchor to a geo record. */
  official_crosscheck: { matched: number; ambiguous: number; unmatched: number } | null;
  /** Wikidata local-name enrichment outcome (null when the connector didn't run). */
  alias_enrichment: AliasEnrichmentStats | null;
  /** Schema defaults carried with NO source behind them — consumers must not read these as facts. */
  unsourced_defaults: string[];
  dropped: { non_restaurant: number; unnamed: number; no_geometry: number; out_of_bbox: number; out_of_admin: number; no_address: number; invalid_phone: number };
  checksum_sha256: string;
  ndjson_file: string;
}

export const SOURCE_LICENSES: Record<string, { license: string; detail: string }> = {
  overture: {
    license: "CDLA-Permissive-2.0",
    detail: "Overture Maps Foundation, places theme (overturemaps.org)",
  },
  fehd_hk: {
    license: "data.gov.hk Terms of Use (free re-use with attribution)",
    detail: "Hong Kong FEHD list of licensed general restaurants",
  },
  la_open_data: {
    license: "CC0/Public Domain (data.lacity.org open data terms)",
    detail: "City of Los Angeles — Listing of Active Businesses (NAICS 7225*)",
  },
  tokyo_opendata: {
    license: "CC-BY-4.0 (東京都オープンデータカタログ; per-dataset terms verified at ingest)",
    detail: "Tokyo ward + TMG food-business licence ledgers via catalog.data.metro.tokyo.lg.jp CKAN search",
  },
  wikidata: {
    license: "CC0-1.0",
    detail: "Wikidata labels/aliases (local-language names), restaurant-family items via WDQS",
  },
};
