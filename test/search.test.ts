import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveBookable, isOpenAt, searchMerchants } from "../src/registry/merchants.js";
import { testDb, insertMerchant } from "./helpers.js";

test("bookable derivation: verified + accepts phone reservations + not opted out + no deposit", () => {
  const base = {
    phone_verified_at: "2026-07-01T00:00:00Z",
    reservation_policy: "accepts_reservations",
    opt_out: 0,
    requires_deposit: 0,
  };
  assert.ok(deriveBookable(base));
  assert.ok(!deriveBookable({ ...base, phone_verified_at: null }));
  assert.ok(!deriveBookable({ ...base, reservation_policy: "walk_in_only" }));
  assert.ok(!deriveBookable({ ...base, opt_out: 1 }));
  assert.ok(!deriveBookable({ ...base, requires_deposit: 1 })); // v1 non-goal: deposits
  assert.ok(deriveBookable({ ...base, reservation_policy: "phone_reservations" }));
});

test("search is filter-based with deterministic merchant_id ordering", () => {
  const db = testDb();
  const a = insertMerchant(db, { merchant_id: "aaaaaaaa-0000-4000-8000-000000000001", cuisine_tags: JSON.stringify(["thai"]) });
  const b = insertMerchant(db, { merchant_id: "bbbbbbbb-0000-4000-8000-000000000002", cuisine_tags: JSON.stringify(["thai"]) });
  insertMerchant(db, { merchant_id: "cccccccc-0000-4000-8000-000000000003", cuisine_tags: JSON.stringify(["french"]) });

  const r = searchMerchants(db, { cuisine_tags: ["thai"] });
  assert.equal(r.total, 2);
  assert.equal(r.order, "merchant_id");
  assert.deepEqual(r.results.map((m) => m.merchant_id), [a, b]);
});

test("opted-out merchants are excluded from discovery but retained", () => {
  const db = testDb();
  insertMerchant(db, { opt_out: 1 });
  const kept = insertMerchant(db);
  const r = searchMerchants(db, {});
  assert.equal(r.total, 1);
  assert.equal(r.results[0].merchant_id, kept);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM merchants").get() as any).c, 2);
});

test("geo filter orders by distance with documented tie-break", () => {
  const db = testDb();
  const far = insertMerchant(db, { merchant_id: "aaaaaaaa-0000-4000-8000-00000000000f", lat: 37.80, lng: -122.41 });
  const close = insertMerchant(db, { merchant_id: "ffffffff-0000-4000-8000-00000000000c", lat: 37.761, lng: -122.411 });
  const r = searchMerchants(db, { near: { lat: 37.76, lng: -122.41, radius_km: 10 }, order_by: "distance" });
  assert.equal(r.order, "distance");
  assert.deepEqual(r.results.map((m) => m.merchant_id), [close, far]);
});

test("open_at honors weekly hours, past-midnight closes, and holiday exceptions", () => {
  const hours = [
    { day: 5, open: "17:00", close: "22:00" },
    { day: 6, open: "20:00", close: "01:30" }, // Saturday late service into Sunday
  ];
  // 2026-07-17 is a Friday
  assert.ok(isOpenAt(hours, [], new Date("2026-07-17T19:00:00Z")));
  assert.ok(!isOpenAt(hours, [], new Date("2026-07-17T23:00:00Z")));
  // Sunday 01:00 falls inside Saturday's past-midnight block
  assert.ok(isOpenAt(hours, [], new Date("2026-07-19T01:00:00Z")));
  assert.ok(!isOpenAt(hours, [], new Date("2026-07-19T02:00:00Z")));
  // Holiday closure wins
  assert.ok(!isOpenAt(hours, [{ date: "2026-07-17", closed: true }], new Date("2026-07-17T19:00:00Z")));
});

test("party_size and bookable_only filters", () => {
  const db = testDb();
  insertMerchant(db, { max_party_size: 4 });
  const big = insertMerchant(db, { max_party_size: 12 });
  insertMerchant(db, { phone_verified_at: null, verification_status: "unverified" });

  const r = searchMerchants(db, { party_size: 6, bookable_only: true });
  assert.equal(r.total, 1);
  assert.equal(r.results[0].merchant_id, big);
});

test("sandbox is visible on compact records and filterable in both directions", () => {
  const db = testDb();
  const testFixture = insertMerchant(db, { sandbox: 1, name: "Sandbox Trattoria" });
  const realVenue = insertMerchant(db, { sandbox: 0, name: "Real Trattoria" });

  // Visible: a sandbox merchant books end-to-end and returns a simulated
  // confirmation, so an agent must be able to tell one apart in search results
  // — not only after a second get_merchant call.
  const all = searchMerchants(db, {});
  assert.equal(all.total, 2, "omitting the filter serves both kinds, as it always has");
  assert.deepEqual(
    Object.fromEntries(all.results.map((r) => [r.merchant_id, r.sandbox])),
    { [testFixture]: true, [realVenue]: false },
  );

  const sandboxOnly = searchMerchants(db, { sandbox: true });
  assert.deepEqual(sandboxOnly.results.map((r) => r.merchant_id), [testFixture]);

  const realOnly = searchMerchants(db, { sandbox: false });
  assert.deepEqual(realOnly.results.map((r) => r.merchant_id), [realVenue]);
});

test("sandbox filter survives the geo/open_at path, which filters in JS", () => {
  const db = testDb();
  insertMerchant(db, { sandbox: 1, lat: 37.76, lng: -122.41 });
  const realVenue = insertMerchant(db, { sandbox: 0, lat: 37.761, lng: -122.411 });

  const r = searchMerchants(db, {
    sandbox: false,
    near: { lat: 37.76, lng: -122.41, radius_km: 2 },
    order_by: "distance",
  });
  assert.deepEqual(r.results.map((m) => m.merchant_id), [realVenue]);
  assert.equal(r.results[0].sandbox, false);
});
