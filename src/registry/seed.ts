/**
 * REQ-ING-1: seed ~500 merchants in the launch city with per-field provenance.
 *
 * In production this pipeline pulls from public sources (business registries,
 * public listings, merchant websites). This module generates a deterministic
 * synthetic corpus with the same shape so the whole system is exercisable
 * end-to-end before the real ingestion connectors are pointed at it.
 *
 * Composition follows Open Decision #2's recommendation: ~80% reservation-taking
 * restaurants concentrated in 4 dense neighborhoods, ~20% breadth.
 */
import type { Database } from "better-sqlite3";
import { getDb, now } from "../db/index.js";
import { addProvenance } from "./merchants.js";
import { config } from "../config.js";

// Deterministic RNG so seeds are reproducible across machines.
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20260715);
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)];
const chance = (p: number) => rand() < p;

function uuid(): string {
  const hex = () => Math.floor(rand() * 16).toString(16);
  const s = (n: number) => Array.from({ length: n }, hex).join("");
  return `${s(8)}-${s(4)}-4${s(3)}-${pick(["8", "9", "a", "b"])}${s(3)}-${s(12)}`;
}

const DENSE_NEIGHBORHOODS = [
  { name: "Mission", lat: 37.7599, lng: -122.4148 },
  { name: "North Beach", lat: 37.8003, lng: -122.4103 },
  { name: "Hayes Valley", lat: 37.7767, lng: -122.4244 },
  { name: "Marina", lat: 37.8005, lng: -122.4368 },
] as const;
const BREADTH_NEIGHBORHOODS = [
  { name: "Richmond", lat: 37.7799, lng: -122.4834 },
  { name: "Sunset", lat: 37.7431, lng: -122.4869 },
  { name: "SoMa", lat: 37.7785, lng: -122.4056 },
  { name: "Castro", lat: 37.7609, lng: -122.435 },
  { name: "Chinatown", lat: 37.7941, lng: -122.4078 },
  { name: "Nob Hill", lat: 37.793, lng: -122.4161 },
] as const;

const CUISINES = [
  "italian", "japanese", "mexican", "thai", "chinese", "french", "indian",
  "korean", "vietnamese", "mediterranean", "american", "seafood", "steakhouse",
  "spanish", "peruvian", "ethiopian", "burmese", "californian",
] as const;

const NAME_PARTS: Record<string, { first: string[]; last: string[] }> = {
  italian: { first: ["Trattoria", "Osteria", "Ristorante", "Nonna's", "Il Forno", "La Piazza"], last: ["Rosa", "Bella", "Milano", "Toscana", "del Mare", "Verde"] },
  japanese: { first: ["Sushi", "Izakaya", "Ramen", "Omakase", "Kaiseki"], last: ["Hana", "Kumo", "Sakura", "Ichiban", "Tsuki", "Kaze"] },
  mexican: { first: ["Taqueria", "Cantina", "El Jardín", "La Cocina", "Casa"], last: ["Azul", "del Sol", "Oaxaca", "Maria", "Nopal", "Agave"] },
  thai: { first: ["Baan", "Thai House", "Lotus", "Bangkok"], last: ["Siam", "Basil", "Orchid", "Kitchen", "Garden"] },
  chinese: { first: ["Golden", "Dragon", "Jade", "Lucky", "Imperial"], last: ["Palace", "Garden", "Wok", "House", "Dumpling Co."] },
  french: { first: ["Bistro", "Brasserie", "Café", "Chez"], last: ["Lumière", "Margaux", "Colette", "du Parc", "Henri"] },
  default: { first: ["The", "Corner", "Harbor", "Fig & ", "Copper", "Wild"], last: ["Table", "Hearth", "Kitchen", "Grove", "Anchor", "Larder", "Room"] },
};

const ATTRIBUTES = [
  "outdoor_seating", "vegetarian_friendly", "vegan_options", "private_rooms",
  "quiet", "lively", "good_for_groups", "counter_seating", "full_bar",
  "wine_list", "kid_friendly", "wheelchair_accessible", "late_night",
] as const;

const STREETS = [
  "Valencia St", "Mission St", "Columbus Ave", "Grant Ave", "Hayes St", "Gough St",
  "Chestnut St", "Union St", "Clement St", "Irving St", "Folsom St", "Castro St",
  "Fillmore St", "Polk St", "Sacramento St", "Divisadero St",
] as const;

function makeHours() {
  // dinner-oriented, some with lunch; closed Monday ~30% of the time
  const closedMonday = chance(0.3);
  const hasLunch = chance(0.45);
  const lateClose = chance(0.2);
  const blocks: { day: number; open: string; close: string }[] = [];
  for (let day = 0; day < 7; day++) {
    if (closedMonday && day === 1) continue;
    if (hasLunch) blocks.push({ day, open: "11:30", close: "14:30" });
    blocks.push({ day, open: "17:00", close: lateClose && day >= 4 ? "23:30" : "22:00" });
  }
  return blocks;
}

export function seedMerchants(db: Database, count = 500) {
  const insert = db.prepare(`
    INSERT INTO merchants (
      merchant_id, name, aliases, category, cuisine_tags, attribute_tags,
      address, neighborhood, city, lat, lng, phone_primary, phone_verified_at,
      hours, holiday_exceptions, price_band, reservation_policy, requires_deposit,
      fulfillment_channel, languages, verification_status, opt_out, sandbox,
      max_party_size, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  const seedAll = db.transaction(() => {
    const usedNames = new Set<string>();
    for (let i = 0; i < count; i++) {
      const dense = i < Math.floor(count * 0.8);
      const hood = dense ? pick(DENSE_NEIGHBORHOODS) : pick(BREADTH_NEIGHBORHOODS);
      const cuisine = pick(CUISINES);
      const parts = NAME_PARTS[cuisine] ?? NAME_PARTS.default;
      const clean = (s: string) => s.replace(/\s+/g, " ").trim();
      let name = clean(`${pick(parts.first)} ${pick(parts.last)}`);
      while (usedNames.has(name)) name = clean(`${pick(parts.first)} ${pick(parts.last)} ${pick(["SF", "II", "on " + pick(STREETS).split(" ")[0]])}`);
      usedNames.add(name);

      // Dense-neighborhood merchants skew reservation-taking (Open Decision #2).
      const policyRoll = rand();
      const reservation_policy = dense
        ? policyRoll < 0.75 ? "accepts_reservations" : policyRoll < 0.88 ? "phone_reservations" : policyRoll < 0.96 ? "walk_in_only" : "requires_deposit"
        : policyRoll < 0.45 ? "accepts_reservations" : policyRoll < 0.6 ? "phone_reservations" : policyRoll < 0.92 ? "walk_in_only" : "requires_deposit";

      // REQ-ING-2 calls for 100% phone verification before launch; mid-pipeline
      // snapshot: ~85% verified (spread over the last 70 days so some are due
      // for re-verification), ~15% still in the verification queue.
      const verified = chance(0.85);
      const verifiedAt = verified
        ? new Date(Date.now() - Math.floor(rand() * 70) * 86400_000).toISOString()
        : null;

      const priceBand = dense ? pick([2, 2, 3, 3, 4] as const) : pick([1, 1, 2, 2, 3] as const);
      const attrs = [...new Set(Array.from({ length: 2 + Math.floor(rand() * 3) }, () => pick(ATTRIBUTES)))];
      const phone = `+1415${String(2000000 + Math.floor(rand() * 7000000)).padStart(7, "0")}`;
      const id = uuid();
      const at = now();

      insert.run(
        id,
        name,
        JSON.stringify([]),
        "restaurant",
        JSON.stringify([cuisine, ...(chance(0.25) ? [pick(CUISINES)] : [])].filter((v, ix, a) => a.indexOf(v) === ix)),
        JSON.stringify(attrs),
        `${100 + Math.floor(rand() * 3800)} ${pick(STREETS)}`,
        hood.name,
        config.launchCity,
        Math.round((hood.lat + (rand() - 0.5) * 0.012) * 1e6) / 1e6,
        Math.round((hood.lng + (rand() - 0.5) * 0.012) * 1e6) / 1e6,
        phone,
        verifiedAt,
        JSON.stringify(makeHours()),
        JSON.stringify(chance(0.1) ? [{ date: "2026-12-25", closed: true }] : []),
        priceBand,
        reservation_policy,
        reservation_policy === "requires_deposit" ? 1 : 0,
        chance(0.08) ? "human_call" : "voice_agent", // REQ-FUL-2: some merchants flagged for human routing
        JSON.stringify([]),
        verified ? "phone_verified" : "unverified",
        0,
        1, // sandbox: the seed corpus is the retained "Stripe-test-card" set — safe to dial via voiceSim
        pick([6, 8, 8, 10, 12] as const),
        at,
        at,
      );

      addProvenance(db, id, "name", "public_listing", "seed import: city business registry");
      addProvenance(db, id, "phone_primary", "public_listing", "seed import: public listings");
      addProvenance(db, id, "hours", "merchant_website", "seed import: merchant website");
      if (verifiedAt) addProvenance(db, id, "phone_primary", "verification_call", "launch verification pass (REQ-ING-2)");
    }
  });

  seedAll();
}

// CLI entry: npm run seed
if (process.argv[1] && process.argv[1].endsWith("seed.ts")) {
  const db = getDb();
  const existing = (db.prepare("SELECT COUNT(*) c FROM merchants").get() as { c: number }).c;
  if (existing > 0) {
    console.log(`Database already has ${existing} merchants — skipping seed. Delete ${config.dbPath} to reseed.`);
  } else {
    seedMerchants(db, 500);
    console.log(`Seeded 500 merchants in ${config.launchCity} → ${config.dbPath}`);
  }
}
