import type { Database } from "better-sqlite3";
import { openTestDb } from "../src/db/index.js";

export function testDb(): Database {
  return openTestDb();
}

let counter = 0;

export function insertMerchant(db: Database, overrides: Record<string, unknown> = {}): string {
  const id = (overrides.merchant_id as string) ?? `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
  const at = new Date().toISOString();
  const row = {
    merchant_id: id,
    name: "Test Trattoria",
    aliases: "[]",
    category: "restaurant",
    cuisine_tags: JSON.stringify(["italian"]),
    attribute_tags: JSON.stringify(["outdoor_seating"]),
    address: "100 Test St",
    neighborhood: "Mission",
    city: "San Francisco, CA",
    lat: 37.76,
    lng: -122.41,
    phone_primary: "+14155550100",
    phone_verified_at: at,
    hours: JSON.stringify([{ day: 5, open: "17:00", close: "22:00" }]),
    holiday_exceptions: "[]",
    price_band: 2,
    reservation_policy: "accepts_reservations",
    requires_deposit: 0,
    fulfillment_channel: "voice_agent",
    languages: "[]",
    verification_status: "phone_verified",
    opt_out: 0,
    sandbox: 1, // default test merchant is a sandbox merchant (bookable end-to-end); override to 0 for real-merchant tests
    max_party_size: 8,
    created_at: at,
    updated_at: at,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO merchants (merchant_id, name, aliases, category, cuisine_tags, attribute_tags,
      address, neighborhood, city, lat, lng, phone_primary, phone_verified_at, hours, holiday_exceptions,
      price_band, reservation_policy, requires_deposit, fulfillment_channel, languages, verification_status,
      opt_out, sandbox, max_party_size, created_at, updated_at)
     VALUES (@merchant_id, @name, @aliases, @category, @cuisine_tags, @attribute_tags,
      @address, @neighborhood, @city, @lat, @lng, @phone_primary, @phone_verified_at, @hours, @holiday_exceptions,
      @price_band, @reservation_policy, @requires_deposit, @fulfillment_channel, @languages, @verification_status,
      @opt_out, @sandbox, @max_party_size, @created_at, @updated_at)`,
  ).run(row);
  return id;
}
