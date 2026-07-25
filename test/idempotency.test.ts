/**
 * Idempotent place_booking (client_reference_id): agents retry timeouts, and a
 * retried place_booking must return the booking it already created — never
 * double-book a real restaurant. Same reference + same request = replay;
 * same reference + different request = conflict, never a silent wrong booking.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { bookingStatus, placeBooking } from "../src/orchestrator/bookings.js";
import { transition } from "../src/orchestrator/stateMachine.js";
import { testDb, insertMerchant } from "./helpers.js";

const request = (mid: string, extra: Record<string, unknown> = {}) => ({
  merchant_id: mid,
  party_size: 2,
  datetime: "2026-07-18T19:00",
  reservation_name: "Pat Doe",
  ...extra,
});

test("identical retry with the same client_reference_id replays the existing booking", () => {
  const db = testDb();
  const mid = insertMerchant(db);
  const first = placeBooking(db, request(mid, { client_reference_id: "ref-1", api_key_id: "key_a" }));
  assert.ok(first.ok, first.error);
  assert.equal(first.idempotent_replay, undefined);

  const retry = placeBooking(db, request(mid, { client_reference_id: "ref-1", api_key_id: "key_a" }));
  assert.ok(retry.ok);
  assert.equal(retry.booking_id, first.booking_id);
  assert.equal(retry.idempotent_replay, true);

  const count = db.prepare("SELECT COUNT(*) AS n FROM bookings").get() as { n: number };
  assert.equal(count.n, 1, "replay must not create a second booking");
});

test("replay reports the booking's CURRENT state, not the state at creation", () => {
  const db = testDb();
  const mid = insertMerchant(db);
  const first = placeBooking(db, request(mid, { client_reference_id: "ref-2" }));
  transition(db, first.booking_id!, "in_progress", {});

  const retry = placeBooking(db, request(mid, { client_reference_id: "ref-2" }));
  assert.ok(retry.ok);
  assert.equal(retry.state, "in_progress");
});

test("replay wins over booking guards: retry finds its booking even after the merchant became unbookable", () => {
  const db = testDb();
  const mid = insertMerchant(db);
  const first = placeBooking(db, request(mid, { client_reference_id: "ref-3" }));
  assert.ok(first.ok);
  db.prepare("UPDATE merchants SET opt_out = 1 WHERE merchant_id = ?").run(mid);

  const retry = placeBooking(db, request(mid, { client_reference_id: "ref-3" }));
  assert.ok(retry.ok, "retry of a timed-out call must return the created booking, not merchant_opted_out");
  assert.equal(retry.booking_id, first.booking_id);
});

test("same reference with different parameters is a conflict, never a silent wrong-booking return", () => {
  const db = testDb();
  const mid = insertMerchant(db);
  assert.ok(placeBooking(db, request(mid, { client_reference_id: "ref-4" })).ok);

  for (const changed of [
    { party_size: 4 },
    { datetime: "2026-07-18T20:00" },
    { reservation_name: "Sam Roe" },
    { merchant_id: insertMerchant(db) },
    { window_minutes: 30 },
  ]) {
    const r = placeBooking(db, { ...request(mid, { client_reference_id: "ref-4" }), ...changed });
    assert.equal(r.ok, false);
    assert.equal(r.error, "client_reference_conflict");
  }
});

test("references are scoped per developer key; anonymous callers share one scope", () => {
  const db = testDb();
  const mid = insertMerchant(db);
  const a = placeBooking(db, request(mid, { client_reference_id: "shared-ref", api_key_id: "key_a" }));
  const b = placeBooking(db, request(mid, { client_reference_id: "shared-ref", api_key_id: "key_b" }));
  const anon = placeBooking(db, request(mid, { client_reference_id: "shared-ref" }));
  assert.ok(a.ok && b.ok && anon.ok);
  assert.notEqual(a.booking_id, b.booking_id);
  assert.notEqual(a.booking_id, anon.booking_id);

  const anonRetry = placeBooking(db, request(mid, { client_reference_id: "shared-ref" }));
  assert.equal(anonRetry.booking_id, anon.booking_id);
  assert.equal(anonRetry.idempotent_replay, true);
});

test("invalid references are rejected before any booking is created", () => {
  const db = testDb();
  const mid = insertMerchant(db);
  for (const bad of ["", "   ", "x".repeat(129)]) {
    const r = placeBooking(db, request(mid, { client_reference_id: bad }));
    assert.equal(r.ok, false);
    assert.match(r.error!, /invalid_client_reference_id/);
  }
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM bookings").get() as { n: number }).n, 0);
});

test("a rejected booking does not consume the reference — the corrected retry succeeds", () => {
  const db = testDb();
  const mid = insertMerchant(db);
  const bad = placeBooking(db, request("no-such-merchant", { client_reference_id: "ref-5" }));
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "unknown_merchant");

  const good = placeBooking(db, request(mid, { client_reference_id: "ref-5" }));
  assert.ok(good.ok, "reference must be free after a failed validation (nothing was created)");
});

test("without a reference, identical calls still create separate bookings (contract unchanged)", () => {
  const db = testDb();
  const mid = insertMerchant(db);
  const a = placeBooking(db, request(mid));
  const b = placeBooking(db, request(mid));
  assert.ok(a.ok && b.ok);
  assert.notEqual(a.booking_id, b.booking_id);
});

test("booking status echoes client_reference_id so agents can correlate", () => {
  const db = testDb();
  const mid = insertMerchant(db);
  const withRef = placeBooking(db, request(mid, { client_reference_id: "ref-6" }));
  assert.equal(bookingStatus(db, withRef.booking_id!)!.client_reference_id, "ref-6");
  const withoutRef = placeBooking(db, request(mid));
  assert.equal(bookingStatus(db, withoutRef.booking_id!)!.client_reference_id, undefined);
});

test("uniqueness is enforced by the database, not only the pre-insert lookup", () => {
  const db = testDb();
  const mid = insertMerchant(db);
  const first = placeBooking(db, request(mid, { client_reference_id: "ref-7", api_key_id: "key_a" }));
  assert.ok(first.ok);
  // A raw duplicate insert (simulating a second process racing past the lookup)
  // must hit the unique index.
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO bookings (booking_id, merchant_id, api_key_id, state, party_size, requested_time, reservation_name, client_reference_id, sla_deadline, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run("11111111-1111-4111-8111-111111111111", mid, "key_a", "pending", 2, "2026-07-18T19:00", "Pat Doe", "ref-7", "x", "x", "x"),
    /UNIQUE/,
  );
});
