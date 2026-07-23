/**
 * Coverage cities, set by @observer 2026-07-16: Los Angeles, Tokyo, Hong Kong.
 * (Data-coverage cities — distinct from the booking launch-city decision,
 * spec §13.1, which remains open.)
 *
 * Bboxes bound both the Overture extract and coordinate validation. LA uses the
 * city proper rather than the county; Tokyo covers the 23 special wards.
 */
import type { CityConfig, CityKey } from "./types.js";

export const CITIES: Record<CityKey, CityConfig> = {
  la: {
    key: "la",
    city: "Los Angeles, CA",
    country: "US",
    timezone: "America/Los_Angeles",
    bbox: { west: -118.6682, south: 33.7037, east: -118.1553, north: 34.3373 },
    officialSources: ["la_open_data"],
  },
  tokyo: {
    key: "tokyo",
    city: "Tokyo",
    country: "JP",
    timezone: "Asia/Tokyo",
    bbox: { west: 139.56, south: 35.53, east: 139.92, north: 35.82 },
    // Per-ward licence ledgers discovered via the TMG open-data catalog's CKAN
    // API — coverage is partial-by-construction (wards publish independently).
    officialSources: ["tokyo_opendata"],
  },
  hk: {
    key: "hk",
    city: "Hong Kong",
    country: "HK",
    timezone: "Asia/Hong_Kong",
    bbox: { west: 113.83, south: 22.15, east: 114.41, north: 22.57 },
    officialSources: ["fehd_hk"],
  },
};

export function getCity(key: string): CityConfig {
  const city = CITIES[key as CityKey];
  if (!city) throw new Error(`Unknown city "${key}" — expected one of: ${Object.keys(CITIES).join(", ")}`);
  return city;
}
