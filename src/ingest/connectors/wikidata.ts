/**
 * Wikidata local-name enrichment — the P1 lever for the HK local-alias gap
 * (and zh names for Shanghai). License: CC0 (labels/aliases are Wikidata
 * content, CC0 1.0), squarely inside the openly-licensed standing rule.
 *
 * Honest scope (data-plan 07-22): Wikidata's per-restaurant coverage is thin
 * outside famous venues and chains — expect hundreds of matches per city, not
 * thousands. That's still real signal: a Wikidata item is independent evidence
 * the place exists, and its local-language labels are exactly the field the
 * register layer can't fill for unmatched records.
 *
 * One WDQS query per city: restaurant-family items (P31/P279* Q11707) with a
 * coordinate inside the city bbox, plus en label and local-language
 * labels/aliases. Enrichment-only and fail-open: a WDQS outage degrades to
 * today's behavior, loudly (the ABR lesson — never let an enrichment host
 * block the weekly release).
 */
import type { CityConfig, SourceRef } from "./../types.js";

export const WIKIDATA_SPARQL = "https://query.wikidata.org/sparql";

/** Concatenation separator for grouped labels — U+001F so real names never collide. */
const SEP = "\u001F";

export interface WikidataPlace {
  ref: SourceRef;
  /** English label when present — a match key against Latin-script place names. */
  name_en: string | null;
  /** Local-language labels + aliases (the payload this connector exists for). */
  names_local: string[];
  lat: number;
  lng: number;
}

/**
 * wikibase:box prunes to the city bbox before the class-tree walk, so the
 * P279* path stays cheap. Labels and altLabels in the city's local languages
 * are grouped per item; items without any local name are useless to us and
 * dropped at parse.
 */
export function buildWikidataQuery(city: CityConfig): string {
  const { west, south, east, north } = city.bbox;
  const langs = city.wikidataLanguages.map((l) => `"${l}"`).join(", ");
  return `SELECT ?item ?coord (SAMPLE(?enLabel) AS ?en) (GROUP_CONCAT(DISTINCT ?localName; separator="\\u001F") AS ?locals) WHERE {
  SERVICE wikibase:box {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:cornerSouthWest "Point(${west} ${south})"^^geo:wktLiteral .
    bd:serviceParam wikibase:cornerNorthEast "Point(${east} ${north})"^^geo:wktLiteral .
  }
  ?item wdt:P31/wdt:P279* wd:Q11707 .
  OPTIONAL { ?item rdfs:label ?enLabel . FILTER(LANG(?enLabel) = "en") }
  OPTIONAL {
    { ?item rdfs:label ?localName . } UNION { ?item skos:altLabel ?localName . }
    FILTER(LANG(?localName) IN (${langs}))
  }
}
GROUP BY ?item ?coord`;
}

interface SparqlBinding {
  item?: { value?: string };
  coord?: { value?: string };
  en?: { value?: string };
  locals?: { value?: string };
}

const POINT_RE = /^Point\(([-\d.]+)\s+([-\d.]+)\)$/i;

/**
 * Parse a SPARQL JSON result into WikidataPlaces. Items with no usable
 * local-language name are dropped (they can't contribute what this connector
 * is for); malformed rows are skipped, never guessed at.
 */
export function parseWikidataResults(json: unknown, retrievedAt: string): WikidataPlace[] {
  const bindings = (json as { results?: { bindings?: SparqlBinding[] } })?.results?.bindings;
  if (!Array.isArray(bindings)) {
    throw new Error("wikidata: response is not SPARQL JSON (results.bindings missing)");
  }
  const out: WikidataPlace[] = [];
  for (const b of bindings) {
    const qid = b.item?.value?.split("/").pop() ?? "";
    const point = POINT_RE.exec(b.coord?.value ?? "");
    if (!/^Q\d+$/.test(qid) || !point) continue;
    const names_local = [...new Set((b.locals?.value ?? "").split(SEP).map((s) => s.trim()).filter(Boolean))];
    if (names_local.length === 0) continue;
    out.push({
      ref: {
        source: "wikidata",
        source_id: qid,
        detail: `Wikidata entity ${qid} (CC0 labels/aliases)`,
        retrieved_at: retrievedAt,
      },
      name_en: b.en?.value?.trim() || null,
      names_local,
      lat: Number(point[2]),
      lng: Number(point[1]),
    });
  }
  return out;
}

export async function fetchWikidataPlaces(city: CityConfig, retrievedAt: string): Promise<WikidataPlace[]> {
  const url = `${WIKIDATA_SPARQL}?query=${encodeURIComponent(buildWikidataQuery(city))}&format=json`;
  const res = await fetch(url, {
    headers: {
      // WDQS policy asks for a descriptive UA with contact surface.
      "user-agent": "mercantry-ingest/0.1 (github.com/mercantry/registry)",
      accept: "application/sparql-results+json",
    },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`wikidata: WDQS HTTP ${res.status} for ${city.key}`);
  const places = parseWikidataResults(await res.json(), retrievedAt);
  console.log(`[wikidata] ${city.key}: ${places.length} restaurant items with local-language names in bbox`);
  return places;
}
