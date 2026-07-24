/**
 * City of Los Angeles — Listing of Active Businesses (Office of Finance),
 * filtered to NAICS 7225* (restaurants and other eating places).
 * License: CC0/public domain per data.lacity.org open data terms.
 *
 * Like FEHD, this is an official-register enrichment source in P0: it confirms
 * a merchant against an active business registration. Rows carry coordinates
 * for most locations, which strengthens matching, but they still don't create
 * standalone merchants until P1 (they lack category granularity and phones).
 */
import type { OfficialRecord } from "./../types.js";

const DATASET = "https://data.lacity.org/resource/6rrh-rzua.json";
const PAGE_SIZE = 10_000;

/**
 * Run #1 finding: filtering on 7225* alone returned 756 rows — most LA
 * registrations carry legacy NAICS codes (722110 full-service, 722211
 * limited-service, pre-2012 revisions) rather than the current 7225xx family.
 */
export const NAICS_PREFIXES = ["7225", "7221", "7222"] as const;

export function buildNaicsWhere(): string {
  return NAICS_PREFIXES.map((p) => `starts_with(naics, '${p}')`).join(" OR ");
}

interface SocrataRow {
  location_account?: string;
  business_name?: string;
  dba_name?: string;
  street_address?: string;
  city?: string;
  location_1?: { latitude?: string; longitude?: string };
  naics?: string;
  council_district?: string;
}

export function parseSocrataRows(rows: SocrataRow[], retrievedAt: string): OfficialRecord[] {
  const out: OfficialRecord[] = [];
  for (const row of rows) {
    const name = (row.dba_name || row.business_name || "").trim();
    if (!name) continue;
    // The dataset spans LA County mailing cities; keep the city proper.
    if (row.city && !row.city.toUpperCase().includes("LOS ANGELES")) continue;
    const lat = row.location_1?.latitude ? Number(row.location_1.latitude) : null;
    const lng = row.location_1?.longitude ? Number(row.location_1.longitude) : null;
    out.push({
      ref: {
        source: "la_open_data",
        source_id: row.location_account ?? `${name}:${row.street_address ?? ""}`,
        detail: `LA Office of Finance active business registration, NAICS ${row.naics ?? "7225*"}`,
        retrieved_at: retrievedAt,
      },
      name,
      name_local: null,
      // council_district is an administrative code, not a neighborhood — run
      // #27's top_neighborhoods were mostly "Council District N" labels minted
      // here and copied into empty neighborhoods by the register fallback.
      // No neighborhood beats a fabricated one.
      district: null,
      address: row.street_address?.trim() ?? null,
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
    });
  }
  return out;
}

export async function fetchLaOpenData(retrievedAt: string): Promise<OfficialRecord[]> {
  const all: OfficialRecord[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const url = `${DATASET}?$where=${encodeURIComponent(buildNaicsWhere())}&$limit=${PAGE_SIZE}&$offset=${offset}&$order=location_account`;
    const res = await fetch(url, {
      headers: { "user-agent": "mercantry-ingest/0.1" },
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`la_open_data: GET page offset=${offset} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const rows = (await res.json()) as SocrataRow[];
    if (!Array.isArray(rows)) throw new Error(`la_open_data: expected a JSON array, got ${typeof rows}`);
    all.push(...parseSocrataRows(rows, retrievedAt));
    if (rows.length < PAGE_SIZE) break;
  }
  if (all.length === 0) {
    throw new Error("la_open_data: 0 records for NAICS 7225* — dataset id or filter column may have drifted");
  }
  return all;
}
