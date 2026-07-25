import { test } from "node:test";
import assert from "node:assert/strict";
import { hasExplicitOffset, parseInstant, toZoneWallClock, zoneDateStr, zoneHHMM } from "../src/registry/time.js";
import { registryMeta, searchMerchants } from "../src/registry/merchants.js";
import { migrate } from "../src/db/index.js";
import { bookingStatus, placeBooking } from "../src/orchestrator/bookings.js";
import { testDb, insertMerchant } from "./helpers.js";

test("hasExplicitOffset recognizes Z and ±hh:mm forms, not naive datetimes", () => {
  assert.ok(hasExplicitOffset("2026-07-18T19:00:00Z"));
  assert.ok(hasExplicitOffset("2026-07-18T19:00:00+09:00"));
  assert.ok(hasExplicitOffset("2026-07-18T19:00-0700"));
  assert.ok(!hasExplicitOffset("2026-07-18T19:00"));
  assert.ok(!hasExplicitOffset("2026-07-18T19:00:00"));
  assert.ok(!hasExplicitOffset("2026-07-18"));
});

test("parseInstant: naive datetimes are wall time in the given zone", () => {
  // Fixed-offset zones
  assert.equal(parseInstant("2026-07-18T19:00", "Asia/Tokyo")?.toISOString(), "2026-07-18T10:00:00.000Z");
  assert.equal(parseInstant("2026-07-18T19:00", "Asia/Hong_Kong")?.toISOString(), "2026-07-18T11:00:00.000Z");
  // DST zone: PDT in July (UTC-7), PST in January (UTC-8)
  assert.equal(parseInstant("2026-07-18T19:00", "America/Los_Angeles")?.toISOString(), "2026-07-19T02:00:00.000Z");
  assert.equal(parseInstant("2026-01-18T19:00", "America/Los_Angeles")?.toISOString(), "2026-01-19T03:00:00.000Z");
  // Space separator (merchant counter-offer format)
  assert.equal(parseInstant("2026-07-18 19:45", "Asia/Tokyo")?.toISOString(), "2026-07-18T10:45:00.000Z");
});

test("parseInstant: explicit offset pins the instant regardless of the zone argument", () => {
  assert.equal(parseInstant("2026-07-18T19:00:00+09:00", "America/Los_Angeles")?.toISOString(), "2026-07-18T10:00:00.000Z");
  assert.equal(parseInstant("2026-07-18T10:00:00Z", "Asia/Tokyo")?.toISOString(), "2026-07-18T10:00:00.000Z");
});

test("parseInstant: unparseable input returns null instead of NaN dates", () => {
  assert.equal(parseInstant("not-a-datetime", "Asia/Tokyo"), null);
  assert.equal(parseInstant("2026-13-99T99:99", "Asia/Tokyo"), null);
});

test("zone wall-clock helpers", () => {
  const instant = new Date("2026-07-18T05:00:00Z");
  assert.equal(zoneHHMM(instant, "Asia/Hong_Kong"), "13:00");
  assert.equal(zoneHHMM(instant, "Asia/Tokyo"), "14:00");
  assert.equal(zoneDateStr(instant, "America/Los_Angeles"), "2026-07-17"); // still the prior evening in LA
  assert.equal(toZoneWallClock(new Date("2026-07-18T10:00:00Z"), "Asia/Tokyo").toISOString(), "2026-07-18T19:00:00.000Z");
});

test("open_at with explicit offset is evaluated in each merchant's own timezone", () => {
  const db = testDb();
  // 2026-07-17 is a Friday; both merchants open Friday 17:00-22:00 local.
  const hours = JSON.stringify([{ day: 5, open: "17:00", close: "22:00" }]);
  const tokyo = insertMerchant(db, { city: "Tokyo", timezone: "Asia/Tokyo", hours });
  const la = insertMerchant(db, { city: "Los Angeles, CA", timezone: "America/Los_Angeles", hours });

  // 19:00 Friday in Tokyo == 03:00 Friday in LA: only the Tokyo merchant is open.
  const atTokyoEvening = searchMerchants(db, { open_at: "2026-07-17T19:00:00+09:00" });
  assert.deepEqual(atTokyoEvening.results.map((m) => m.merchant_id), [tokyo]);

  // Same instant expressed in Z form behaves identically.
  const zForm = searchMerchants(db, { open_at: "2026-07-17T10:00:00Z" });
  assert.deepEqual(zForm.results.map((m) => m.merchant_id), [tokyo]);

  // 19:00 Friday in LA == 11:00 Saturday in Tokyo: only the LA merchant is open.
  const atLaEvening = searchMerchants(db, { open_at: "2026-07-17T19:00:00-07:00" });
  assert.deepEqual(atLaEvening.results.map((m) => m.merchant_id), [la]);

  // Naive datetime = each merchant's local wall clock: both are open at their own 19:00.
  const naive = searchMerchants(db, { open_at: "2026-07-17T19:00" });
  assert.equal(naive.total, 2);
});

test("unparseable open_at fails fast with a typed error (was a crash)", () => {
  const db = testDb();
  insertMerchant(db);
  assert.throws(() => searchMerchants(db, { open_at: "banana" }), /invalid_open_at/);
  assert.throws(() => searchMerchants(db, { open_at: "2026-99-99T99:99" }), /invalid_open_at/);
});

test("search results carry the merchant timezone", () => {
  const db = testDb();
  insertMerchant(db, { city: "Hong Kong", timezone: "Asia/Hong_Kong" });
  const r = searchMerchants(db, {});
  assert.equal(r.results[0].timezone, "Asia/Hong_Kong");
});

test("migration backfills timezone by city for pre-column rows", () => {
  const db = testDb();
  const hk = insertMerchant(db, { city: "Hong Kong", timezone: null });
  const tokyo = insertMerchant(db, { city: "Tokyo", timezone: null });
  const sf = insertMerchant(db, { city: "San Francisco, CA", timezone: null });
  migrate(db);
  const tz = (id: string) => (db.prepare("SELECT timezone FROM merchants WHERE merchant_id = ?").get(id) as any).timezone;
  assert.equal(tz(hk), "Asia/Hong_Kong");
  assert.equal(tz(tokyo), "Asia/Tokyo");
  assert.equal(tz(sf), "America/Los_Angeles");
});

test("booking status is timezone-explicit: merchant zone + UTC instants alongside the stored strings", () => {
  const db = testDb();
  const id = insertMerchant(db); // sandbox SF merchant, America/Los_Angeles
  const placed = placeBooking(db, {
    merchant_id: id,
    party_size: 2,
    datetime: "2026-07-18T19:00",
    reservation_name: "Pat Doe",
  });
  assert.ok(placed.ok);
  const status = bookingStatus(db, placed.booking_id!)!;
  assert.equal(status.requested_time, "2026-07-18T19:00"); // echoed as stored
  assert.equal(status.timezone, "America/Los_Angeles");
  assert.equal(status.requested_time_utc, "2026-07-19T02:00:00.000Z"); // 19:00 PDT
});

test("place_booking accepts tz-explicit datetimes and still rejects garbage", () => {
  const db = testDb();
  const id = insertMerchant(db);
  const explicit = placeBooking(db, {
    merchant_id: id,
    party_size: 2,
    datetime: "2026-07-18T19:00:00+09:00",
    reservation_name: "Pat Doe",
  });
  assert.ok(explicit.ok);
  const garbage = placeBooking(db, {
    merchant_id: id,
    party_size: 2,
    datetime: "tonight-ish",
    reservation_name: "Pat Doe",
  });
  assert.equal(garbage.ok, false);
  assert.equal(garbage.error, "invalid_datetime");
});

test("registry meta lists per-city coverage with timezones (served cities only)", () => {
  const db = testDb();
  insertMerchant(db, { sandbox: 0, city: "Hong Kong", timezone: "Asia/Hong_Kong" });
  insertMerchant(db, { sandbox: 0, city: "Hong Kong", timezone: "Asia/Hong_Kong" });
  insertMerchant(db, { sandbox: 0, city: "Tokyo", timezone: "Asia/Tokyo" });
  insertMerchant(db); // sandbox merchant: never listed as public coverage
  const meta = registryMeta(db) as any;
  assert.deepEqual(meta.cities, [
    { city: "Hong Kong", timezone: "Asia/Hong_Kong", merchant_count: 2 },
    { city: "Tokyo", timezone: "Asia/Tokyo", merchant_count: 1 },
  ]);
});
