/**
 * Sandbox "test cards" (AGENT-UX §6): place_booking's optional sandbox_outcome
 * forces the simulated call's result so an integrator — or a directory
 * reviewer following /demo — can walk a chosen branch of the booking state
 * machine on demand instead of taking the pseudo-random draw.
 *
 * The invariants worth locking: the field is sandbox-only, an unforced booking
 * behaves exactly as it did before the field existed, and a request that does
 * not use it hashes to the same idempotency fingerprint as the pre-change
 * implementation (otherwise a stored fingerprint would turn into a spurious
 * client_reference_conflict).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { placeBooking, bookingStatus } from "../src/orchestrator/bookings.js";
import { pickOutcome } from "../src/orchestrator/voiceSim.js";
import { tick } from "../src/orchestrator/worker.js";
import { config } from "../src/config.js";
import { SANDBOX_OUTCOMES } from "../src/registry/types.js";
import { testDb, insertMerchant } from "./helpers.js";

const REQUESTED = "2026-07-18T19:00";

function book(db: any, mid: string, extra: Record<string, unknown> = {}) {
  return placeBooking(db, {
    merchant_id: mid,
    party_size: 2,
    datetime: REQUESTED,
    reservation_name: "Pat Doe",
    ...extra,
  } as any);
}

test("a forced outcome overrides the draw, for every documented value", () => {
  const expected: Record<string, string> = {
    confirmed: "confirmed",
    no_answer: "no_answer",
    counter_offer: "counter_offer",
    fully_booked: "failed",
    merchant_declined: "failed",
    bad_data: "failed",
  };
  for (const outcome of SANDBOX_OUTCOMES) {
    // Same booking id and attempt for all of them: only the forcing differs,
    // which is exactly what proves the draw was overridden.
    const got = pickOutcome("booking-fixed-id", 1, REQUESTED, outcome);
    assert.equal(got.kind, expected[outcome], `${outcome} → ${got.kind}`);
    if (got.kind === "failed") assert.equal(got.reason, outcome);
  }
  const counter = pickOutcome("booking-fixed-id", 1, REQUESTED, "counter_offer");
  assert.equal(counter.kind === "counter_offer" && counter.offered_times.length, 2);
});

test("an unforced call is byte-identical to the pre-field behavior", () => {
  for (const id of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
    const drawn = pickOutcome(id, 1, REQUESTED);
    assert.deepEqual(pickOutcome(id, 1, REQUESTED, null), drawn);
    assert.deepEqual(pickOutcome(id, 1, REQUESTED, undefined), drawn);
    // An unrecognized value can never reach the simulator (placeBooking rejects
    // it), and if one somehow did it must fall through to the draw, not throw.
    assert.deepEqual(pickOutcome(id, 1, REQUESTED, "not_an_outcome"), drawn);
  }
});

test("place_booking stores the forced outcome and echoes it back", () => {
  const db = testDb();
  const mid = insertMerchant(db);
  const res = book(db, mid, { sandbox_outcome: "counter_offer" });
  assert.ok(res.ok, res.error);
  const row = db.prepare("SELECT sandbox_outcome FROM bookings WHERE booking_id = ?").get(res.booking_id!) as any;
  assert.equal(row.sandbox_outcome, "counter_offer");
  assert.equal(bookingStatus(db, res.booking_id!)!.sandbox_outcome, "counter_offer");
  // Omitted stays NULL — the default draw, unchanged.
  const plain = book(db, mid);
  assert.equal((db.prepare("SELECT sandbox_outcome FROM bookings WHERE booking_id = ?").get(plain.booking_id!) as any).sandbox_outcome, null);
  assert.equal(bookingStatus(db, plain.booking_id!)!.sandbox_outcome, undefined);
});

test("an unknown outcome is rejected with the allowed list", () => {
  const db = testDb();
  const mid = insertMerchant(db);
  const res = book(db, mid, { sandbox_outcome: "confirmed_please" });
  assert.equal(res.ok, false);
  assert.equal(res.error, "invalid_sandbox_outcome");
  assert.equal(res.field, "sandbox_outcome");
  for (const o of SANDBOX_OUTCOMES) assert.match(res.allowed!, new RegExp(o));
  // A rejected request creates nothing.
  assert.equal((db.prepare("SELECT COUNT(*) c FROM bookings").get() as any).c, 0);
});

test("forcing an outcome on a real merchant is refused, not silently ignored", () => {
  const db = testDb();
  const real = insertMerchant(db, { sandbox: 0, fulfillment_channel: "human_call" });
  // While no channel is live, the honest fulfillment guard answers first.
  assert.equal(book(db, real, { sandbox_outcome: "confirmed" }).error, "fulfillment_not_live");

  // With a live channel (the note-004 seam), the sandbox-only rule is what
  // stops a caller from scripting a real restaurant's answer.
  // The config object is frozen at import; the seam is opened for this test
  // only and restored in the finally below.
  const mutable = config.fulfillment as { liveChannels: readonly string[] };
  const live = mutable.liveChannels;
  mutable.liveChannels = ["human_call"];
  try {
    const res = book(db, real, { sandbox_outcome: "confirmed" });
    assert.equal(res.ok, false);
    assert.equal(res.error, "sandbox_outcome_requires_sandbox_merchant");
    // ...and the merchant is still bookable without the field, so the refusal
    // is about the field alone.
    assert.ok(book(db, real).ok);
  } finally {
    mutable.liveChannels = live;
  }
});

test("a request without sandbox_outcome keeps its pre-change idempotency fingerprint", () => {
  const db = testDb();
  const mid = insertMerchant(db);
  const res = book(db, mid, { client_reference_id: "ref-legacy" });
  // The canonical form as it existed before sandbox_outcome was added. If the
  // field ever leaks unconditionally into the hash, every stored fingerprint
  // would start mismatching its own replay — this fails first.
  const legacy = createHash("sha256")
    .update(
      JSON.stringify({
        merchant_id: mid,
        party_size: 2,
        datetime: REQUESTED,
        window_minutes: 0,
        accept_within_window: false,
        reservation_name: "Pat Doe",
        contact: null,
        special_requests: null,
        callback_url: null,
      }),
    )
    .digest("hex");
  const stored = (db.prepare("SELECT request_fingerprint FROM bookings WHERE booking_id = ?").get(res.booking_id!) as any)
    .request_fingerprint;
  assert.equal(stored, legacy);
  // And the replay still works against it.
  const replay = book(db, mid, { client_reference_id: "ref-legacy" });
  assert.equal(replay.idempotent_replay, true);
  assert.equal(replay.booking_id, res.booking_id);
});

test("the forced outcome is part of the request identity", () => {
  const db = testDb();
  const mid = insertMerchant(db);
  const first = book(db, mid, { client_reference_id: "ref-1", sandbox_outcome: "confirmed" });
  assert.ok(first.ok, first.error);
  // Same reference, same everything → replay.
  assert.equal(book(db, mid, { client_reference_id: "ref-1", sandbox_outcome: "confirmed" }).idempotent_replay, true);
  // Same reference, different forced outcome → a different request, refused.
  assert.equal(book(db, mid, { client_reference_id: "ref-1", sandbox_outcome: "fully_booked" }).error, "client_reference_conflict");
});

test("end to end: a forced outcome drives the booking to its promised state", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const db = testDb();

  const drive = async (outcome: string, extra: Record<string, unknown> = {}) => {
    const mid = insertMerchant(db);
    const res = book(db, mid, { sandbox_outcome: outcome, ...extra });
    assert.ok(res.ok, res.error);
    tick(db); // dispatch: queued → in_progress, simulated call starts
    // Each transcript line schedules the next one, so advance repeatedly and
    // let the microtask queue drain between advances.
    for (let i = 0; i < 12; i++) {
      t.mock.timers.tick(config.fulfillment.simLineDelayMs);
      await new Promise((r) => setImmediate(r));
    }
    return bookingStatus(db, res.booking_id!)!;
  };

  const confirmed = await drive("confirmed");
  assert.equal(confirmed.state, "confirmed");
  assert.ok(confirmed.confirmation_code);
  assert.equal(confirmed.confirmed_time, REQUESTED);

  for (const reason of ["fully_booked", "merchant_declined", "bad_data"]) {
    const failed = await drive(reason);
    assert.equal(failed.state, "failed", reason);
    assert.equal(failed.failure_reason, reason);
  }

  // counter_offer inside an authorized window auto-confirms (the +45min offer)...
  const auto = await drive("counter_offer", { window_minutes: 60, accept_within_window: true });
  assert.equal(auto.state, "confirmed");
  // ...and without that authorization it pauses for the agent to decide.
  const paused = await drive("counter_offer");
  assert.equal(paused.state, "needs_input");
  assert.equal(paused.needs_input_options?.length, 2);
});
