/**
 * Fail-closed release validation: a release with any error is never written.
 * Warnings and coverage stats land in the manifest so consumers (and the
 * board) see data quality honestly instead of discovering it record by record.
 */
import type { CityConfig, FieldCoverage, ReleaseMerchant } from "./types.js";
import { E164_RE, inBbox } from "./normalize.js";

export interface ValidationReport {
  errors: string[];
  warnings: string[];
  field_coverage: FieldCoverage;
}

export function validateRelease(city: CityConfig, merchants: ReleaseMerchant[]): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (merchants.length === 0) errors.push("empty release: 0 merchants");

  const seenIds = new Set<string>();
  const seenNameAddr = new Set<string>();
  let phone = 0, website = 0, neighborhood = 0, cuisine = 0, localAlias = 0, localName = 0;
  const nonAscii = (s: string) => /[^\p{ASCII}]/u.test(s);

  for (const m of merchants) {
    const label = `${m.merchant_id} (${m.name})`;
    if (seenIds.has(m.merchant_id)) errors.push(`duplicate merchant_id: ${label}`);
    seenIds.add(m.merchant_id);

    if (!m.name.trim()) errors.push(`empty name: ${m.merchant_id}`);
    if (!inBbox(m.location.lat, m.location.lng, city.bbox)) {
      errors.push(`coordinates outside ${city.key} bbox: ${label} @ ${m.location.lat},${m.location.lng}`);
    }
    if (m.location.city !== city.city) errors.push(`wrong city value: ${label} has "${m.location.city}"`);
    if (m.timezone !== city.timezone) errors.push(`wrong timezone: ${label} has "${m.timezone}"`);
    if (m.phone_primary && !E164_RE.test(m.phone_primary)) {
      errors.push(`non-E.164 phone: ${label} has "${m.phone_primary}"`);
    }
    if (m.bookable !== false || m.verification_status !== "unverified" || m.phone_verified_at !== null) {
      errors.push(`ingested record claims verification it never had: ${label}`);
    }
    if (m.source_provenance.length === 0) errors.push(`no provenance: ${label}`);

    const nameAddr = `${m.name}|${m.location.address}`.toLowerCase();
    if (m.location.address && seenNameAddr.has(nameAddr)) {
      warnings.push(`possible undeduped pair (same name+address): ${label}`);
    }
    seenNameAddr.add(nameAddr);

    if (m.phone_primary) phone++;
    if (m.website) website++;
    if (m.location.neighborhood) neighborhood++;
    if (m.cuisine_tags.length > 0) cuisine++;
    if (m.aliases.some(nonAscii)) localAlias++;
    if (nonAscii(m.name) || m.aliases.some(nonAscii)) localName++;
  }

  const n = merchants.length || 1;
  const pct = (x: number) => Math.round((x / n) * 1000) / 1000;
  return {
    errors,
    warnings,
    field_coverage: {
      phone: pct(phone),
      website: pct(website),
      neighborhood: pct(neighborhood),
      cuisine: pct(cuisine),
      local_alias: pct(localAlias),
      local_name: pct(localName),
    },
  };
}
