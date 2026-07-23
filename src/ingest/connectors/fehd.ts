/**
 * Hong Kong FEHD licensed general restaurants — the official license register.
 * License: data.gov.hk Terms of Use (free re-use with attribution).
 *
 * The register carries no coordinates, so it is enrichment-only in P0: it
 * confirms a merchant against a live government license, contributes the
 * Chinese name as an alias, and fills the district. The EN and ZH files share
 * license numbers, which is the join key.
 *
 * Parsing is deliberately defensive: the XML schema is not formally published,
 * so the parser extracts generic child tags per record and maps the field
 * names observed in the feed (SS = shop sign, ADR = address, DIST = district,
 * LICNO = license number). If the feed shape drifts, it fails loudly with the
 * tag names it found rather than silently emitting garbage.
 */
import type { OfficialRecord } from "./../types.js";

export const FEHD_URLS = {
  en: "https://www.fehd.gov.hk/english/licensing/license/text/LP_Restaurants_EN.XML",
  // Runs #1/#2 finding: the Chinese file is LP_Restaurants_TC.XML (Traditional
  // Chinese) under /tc_chi/ — per the data.gov.hk resource for dataset
  // hk-fehd-fehdlmis-restaurant-licences. Candidates tried in order.
  zh: [
    "https://www.fehd.gov.hk/tc_chi/licensing/license/text/LP_Restaurants_TC.XML",
    "https://www.fehd.gov.hk/tc_chi/licensing/license/text/LP_Restaurants_CN.XML",
  ],
};

const FIELD_MAP = {
  name: ["SS", "PREM_NAME", "NAME"],
  district: ["DIST", "DISTRICT"],
  address: ["ADR", "ADDR", "ADDRESS"],
  license: ["LICNO", "LIC_NO", "LICENCE_NO"],
} as const;

/** Extract repeated record elements as tag→text dicts, without an XML dependency. */
export function extractXmlRecords(xml: string): Record<string, string>[] {
  const records: Record<string, string>[] = [];
  const recordRe = /<(LP|G|ROW|RECORD)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  const fieldRe = /<([A-Za-z_][\w.-]*)\b[^>]*>([\s\S]*?)<\/\1>/g;
  for (const rec of xml.matchAll(recordRe)) {
    const fields: Record<string, string> = {};
    for (const f of rec[2].matchAll(fieldRe)) {
      fields[f[1].toUpperCase()] = decodeEntities(f[2].trim());
    }
    if (Object.keys(fields).length > 0) records.push(fields);
  }
  return records;
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .trim();
}

function fieldOf(rec: Record<string, string>, candidates: readonly string[]): string | null {
  for (const key of candidates) {
    const v = rec[key];
    if (v) return v;
  }
  return null;
}

export function parseFehdXml(xmlEn: string, xmlZh: string | null, retrievedAt: string): OfficialRecord[] {
  const enRecords = extractXmlRecords(xmlEn);
  if (enRecords.length === 0) {
    throw new Error(
      `fehd_hk: no records parsed from EN feed — schema may have drifted. First 300 chars: ${xmlEn.slice(0, 300)}`,
    );
  }

  const zhByLicense = new Map<string, string>();
  if (xmlZh) {
    for (const rec of extractXmlRecords(xmlZh)) {
      const lic = fieldOf(rec, FIELD_MAP.license);
      const name = fieldOf(rec, FIELD_MAP.name);
      if (lic && name) zhByLicense.set(lic, name);
    }
  }

  const out: OfficialRecord[] = [];
  for (const rec of enRecords) {
    const name = fieldOf(rec, FIELD_MAP.name);
    const license = fieldOf(rec, FIELD_MAP.license);
    if (!name || !license) continue;
    out.push({
      ref: {
        source: "fehd_hk",
        source_id: license,
        detail: `FEHD licensed general restaurant, licence ${license}`,
        retrieved_at: retrievedAt,
      },
      name,
      name_local: zhByLicense.get(license) ?? null,
      district: fieldOf(rec, FIELD_MAP.district),
      address: fieldOf(rec, FIELD_MAP.address),
      lat: null,
      lng: null,
    });
  }
  if (out.length === 0) {
    throw new Error(
      `fehd_hk: records parsed but none had both a name and a licence number. Tags seen: ${Object.keys(enRecords[0]).join(", ")}`,
    );
  }
  return out;
}

export async function fetchFehd(retrievedAt: string): Promise<OfficialRecord[]> {
  const [en, zh] = await Promise.all([fetchText(FEHD_URLS.en), fetchZhFeed()]);
  return parseFehdXml(en, zh, retrievedAt);
}

async function fetchZhFeed(): Promise<string | null> {
  const errors: string[] = [];
  for (const url of FEHD_URLS.zh) {
    try {
      return await fetchText(url);
    } catch (err) {
      errors.push(String(err));
    }
  }
  console.warn(`fehd_hk: ZH feed unavailable (${errors.join("; ")}); proceeding without Chinese names`);
  return null;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "user-agent": "mercantry-ingest/0.1" },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return res.text();
}
