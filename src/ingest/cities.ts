/**
 * Coverage cities, set 2026-07-16: Los Angeles, Tokyo, Hong Kong.
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
    wikidataLanguages: [],
  },
  tokyo: {
    key: "tokyo",
    city: "Tokyo",
    country: "JP",
    timezone: "Asia/Tokyo",
    bbox: { west: 139.56, south: 35.53, east: 139.92, north: 35.82 },
    // The bbox's south/west/north edges cross prefecture lines (Kawasaki,
    // Ichikawa, Kawaguchi). Non-Tokyo prefectures are out of coverage;
    // JP-13 municipalities outside the 23 wards (Mitaka, Chōfu) stay — still
    // Tokyo-to, and the ward ledgers simply won't cover them. Name aliases
    // alongside the ISO codes because run #25's kept-side breakdown showed
    // Overture ships free-text prefecture names (神奈川県/Kanagawa-ken/
    // "Kanagawa Prefecture"), almost never ISO codes.
    adminExclude: [
      { region: "JP-11" }, { region: "埼玉" }, { region: "Saitama" },
      { region: "JP-12" }, { region: "千葉" }, { region: "Chiba" },
      { region: "JP-14" }, { region: "神奈川" }, { region: "Kanagawa" },
    ],
    // Per-ward licence ledgers discovered via the TMG open-data catalog's CKAN
    // API — coverage is partial-by-construction (wards publish independently).
    officialSources: ["tokyo_opendata"],
    wikidataLanguages: ["ja"],
  },
  hk: {
    key: "hk",
    city: "Hong Kong",
    country: "HK",
    timezone: "Asia/Hong_Kong",
    bbox: { west: 113.83, south: 22.15, east: 114.41, north: 22.57 },
    // The bbox's north edge crosses the Sham Chun River into dense central
    // Shenzhen (Luohu/Futian) — mainland records are out of coverage and can
    // never match FEHD. HK itself is its own ISO country (records carry
    // country "HK"), so a plain country rule is safe.
    adminExclude: [{ country: "CN" }],
    officialSources: ["fehd_hk"],
    // The local-alias gap city (69% local_name): Cantonese + Traditional
    // Chinese label variants all carry usable names.
    wikidataLanguages: ["zh", "zh-hk", "zh-hant", "yue"],
  },
  sh: {
    key: "sh",
    city: "Shanghai",
    country: "CN",
    timezone: "Asia/Shanghai",
    // Central Shanghai + Pudong (operator direction 07-23). Overture-only and
    // honestly register-less: no mainland open licence register meets the
    // clean-sources rule (Dianping/Meituan ToS-locked = banned). NOT SERVED:
    // releases build + QA, but import to the live endpoint is gated on the
    // China legal read (PIPL/DSL).
    bbox: { west: 121.2, south: 31.0, east: 121.8, north: 31.45 },
    officialSources: [],
    // Wikidata (CC0) is the one clean local-name lever for the register-less
    // city (board 07-23: Simplified-Chinese names).
    wikidataLanguages: ["zh", "zh-hans", "zh-cn"],
  },
};

export function getCity(key: string): CityConfig {
  const city = CITIES[key as CityKey];
  if (!city) throw new Error(`Unknown city "${key}" — expected one of: ${Object.keys(CITIES).join(", ")}`);
  return city;
}
