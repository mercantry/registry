/**
 * Booking guard (note 004 discovery-only cutover) — the sim-safety invariant:
 * voiceSim may NEVER dial a real (non-sandbox) merchant. Real merchants serve
 * for discovery but are not fulfillable until human-operator fulfillment is live.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { placeBooking, fulfillmentEligibility, bookingStatus } from "../src/orchestrator/bookings.js";
import { tick } from "../src/orchestrator/worker.js";
import { transition } from "../src/orchestrator/stateMachine.js";
import { registryMeta } from "../src/registry/merchants.js";
import { testDb, insertMerchant } from "./helpers.js";

const bookInput = (mid: string) => ({
  merchant_id: mid,
  party_size: 2,
  datetime: "2026-07-25T19:00",
  reservation_name: "Pat Doe",
});

test("place_booking rejects a real (non-sandbox) merchant with fulfillment_not_live", () => {
  const db = testDb();
  // A real merchant, even fully phone-verified and reservation-taking, is not bookable.
  const real = insertMerchant(db, { sandbox: 0, phone_verified_at: new Date().toISOString(), verification_status: "phone_verified" });
  const res = placeBooking(db, bookInput(real));
  assert.equal(res.ok, false);
  assert.equal(res.error, "fulfillment_not_live");
});

test("the guard reason wins over incidental bookability reasons", () => {
  const db = testDb();
  // Real + unverified: without the guard this would report merchant_not_phone_verified.
  const real = insertMerchant(db, { sandbox: 0, phone_verified_at: null, verification_status: "unverified" });
  assert.equal(placeBooking(db, bookInput(real)).error, "fulfillment_not_live");
});

test("sandbox merchants remain bookable end-to-end", () => {
  const db = testDb();
  const sb = insertMerchant(db, { sandbox: 1 });
  const res = placeBooking(db, bookInput(sb));
  assert.ok(res.ok, res.error);
  assert.equal(res.state, "queued");
});

test("fulfillmentEligibility opens only when the channel is declared live (forward-compat)", () => {
  // Documents the note-004 seam without mutating global config in the suite.
  const realHuman = { sandbox: 0, fulfillment_channel: "human_call" };
  const realVoice = { sandbox: 0, fulfillment_channel: "voice_agent" };
  const sandbox = { sandbox: 1, fulfillment_channel: "voice_agent" };
  // Default config.liveChannels is empty → all real merchants blocked; sandbox always ok.
  assert.equal(fulfillmentEligibility(realHuman as any).ok, false);
  assert.equal(fulfillmentEligibility(realVoice as any).ok, false);
  assert.equal(fulfillmentEligibility(sandbox as any).ok, true);
});

test("worker fails a non-sandbox booking closed rather than dialing (structural backstop)", () => {
  const db = testDb();
  // Force a real merchant's booking into the queue, bypassing place_booking's guard,
  // to prove the worker itself refuses to dial it.
  const real = insertMerchant(db, { sandbox: 0 });
  const sla = new Date(Date.now() + 3600_000).toISOString();
  const at = new Date().toISOString();
  db.prepare(
    `INSERT INTO bookings (booking_id, merchant_id, state, party_size, requested_time, window_minutes,
      accept_within_window, reservation_name, attempts, sla_deadline, created_at, updated_at)
     VALUES ('b-guard', @mid, 'pending', 2, '2026-07-25T19:00', 0, 0, 'Pat Doe', 0, @sla, @at, @at)`,
  ).run({ mid: real, sla, at });
  transition(db, "b-guard", "queued", {});

  tick(db); // worker sweep

  const s = bookingStatus(db, "b-guard")!;
  assert.equal(s.state, "failed");
  assert.equal(s.failure_reason, "fulfillment_not_live");
  // And no call was ever placed.
  const calls = db.prepare("SELECT COUNT(*) c FROM call_attempts WHERE booking_id = 'b-guard'").get() as { c: number };
  assert.equal(calls.c, 0);
});

test("registry_meta exposes sandbox vs real counts and the booking policy honestly", () => {
  const db = testDb();
  insertMerchant(db, { sandbox: 1 });
  insertMerchant(db, { sandbox: 0 });
  insertMerchant(db, { sandbox: 0 });
  const meta = registryMeta(db);
  assert.equal(meta.sandbox_count, 1);
  assert.equal(meta.real_count, 2);
  assert.match(meta.booking_policy, /discovery-only|fulfillment_not_live/);
});
