import { test } from "node:test";
import assert from "node:assert/strict";
import { placeBooking, modifyBooking, cancelBooking, resolveFromCall, bookingStatus } from "../src/orchestrator/bookings.js";
import { transition } from "../src/orchestrator/stateMachine.js";
import { finishAttempt } from "../src/orchestrator/worker.js";
import { submitFeedback } from "../src/feedback/feedback.js";
import { testDb, insertMerchant } from "./helpers.js";

const now = () => new Date().toISOString();

function bookOk(db: any, mid: string, extra: Record<string, unknown> = {}) {
  const r = placeBooking(db, {
    merchant_id: mid,
    party_size: 2,
    datetime: "2026-07-18T19:00",
    reservation_name: "Pat Doe",
    ...extra,
  } as any);
  assert.ok(r.ok, r.error);
  return r.booking_id!;
}

test("place_booking rejects non-bookable merchants with structured reasons", () => {
  const db = testDb();
  const deposit = insertMerchant(db, { reservation_policy: "requires_deposit", requires_deposit: 1 });
  const unverified = insertMerchant(db, { phone_verified_at: null });
  const optedOut = insertMerchant(db, { opt_out: 1 });
  const walkIn = insertMerchant(db, { reservation_policy: "walk_in_only" });

  assert.match(placeBooking(db, { merchant_id: deposit, party_size: 2, datetime: "2026-07-18T19:00", reservation_name: "A" }).error!, /deposit/);
  assert.match(placeBooking(db, { merchant_id: unverified, party_size: 2, datetime: "2026-07-18T19:00", reservation_name: "A" }).error!, /not_phone_verified/);
  assert.match(placeBooking(db, { merchant_id: optedOut, party_size: 2, datetime: "2026-07-18T19:00", reservation_name: "A" }).error!, /opted_out/);
  assert.match(placeBooking(db, { merchant_id: walkIn, party_size: 2, datetime: "2026-07-18T19:00", reservation_name: "A" }).error!, /policy/);
  assert.match(placeBooking(db, { merchant_id: "nope", party_size: 2, datetime: "2026-07-18T19:00", reservation_name: "A" }).error!, /unknown/);
});

test("party size and special request limits enforced", () => {
  const db = testDb();
  const mid = insertMerchant(db, { max_party_size: 6 });
  assert.match(placeBooking(db, { merchant_id: mid, party_size: 10, datetime: "2026-07-18T19:00", reservation_name: "A" }).error!, /party_size/);
  assert.match(
    placeBooking(db, { merchant_id: mid, party_size: 2, datetime: "2026-07-18T19:00", reservation_name: "A", special_requests: "x".repeat(300) }).error!,
    /too_long/,
  );
});

test("needs_input → accept option confirms with code", () => {
  const db = testDb();
  const mid = insertMerchant(db);
  const id = bookOk(db, mid);
  transition(db, id, "in_progress", {});
  resolveFromCall(db, id, { kind: "needs_input", options: [{ time: "2026-07-18 20:30" }, { time: "2026-07-18 21:00" }] });
  assert.equal(bookingStatus(db, id)!.state, "needs_input");

  const r = modifyBooking(db, id, { accept_option_index: 1 });
  assert.ok(r.ok);
  const s = bookingStatus(db, id)!;
  assert.equal(s.state, "confirmed");
  assert.equal(s.confirmed_time, "2026-07-18 21:00");
  assert.ok(s.confirmation_code);
});

test("counter-offer auto-accepts within authorized window (REQ-MCP-2)", () => {
  const db = testDb();
  const mid = insertMerchant(db);
  const id = bookOk(db, mid, { window_minutes: 60, accept_within_window: true });
  transition(db, id, "in_progress", { call_id: "c1" });
  db.prepare("INSERT INTO call_attempts (call_id, booking_id, attempt_no, channel, started_at, transcript) VALUES ('c1', ?, 1, 'voice_agent', ?, '[]')").run(id, now());

  finishAttempt(db, "c1", id, 1, { kind: "counter_offer", offered_times: ["2026-07-18 19:45", "2026-07-18 21:30"] });
  const s = bookingStatus(db, id)!;
  assert.equal(s.state, "confirmed");
  assert.equal(s.confirmed_time, "2026-07-18 19:45"); // 45 min shift, inside ±60
});

test("counter-offer outside window pauses in needs_input", () => {
  const db = testDb();
  const mid = insertMerchant(db);
  const id = bookOk(db, mid, { window_minutes: 15, accept_within_window: true });
  transition(db, id, "in_progress", { call_id: "c2" });
  db.prepare("INSERT INTO call_attempts (call_id, booking_id, attempt_no, channel, started_at, transcript) VALUES ('c2', ?, 1, 'voice_agent', ?, '[]')").run(id, now());

  finishAttempt(db, "c2", id, 1, { kind: "counter_offer", offered_times: ["2026-07-18 20:30"] });
  const s = bookingStatus(db, id)!;
  assert.equal(s.state, "needs_input");
  assert.equal(s.needs_input_options.length, 1);
});

test("no_answer retries then fails terminally after max attempts (REQ-FUL-6)", () => {
  const db = testDb();
  const mid = insertMerchant(db);
  const id = bookOk(db, mid);
  for (let attempt = 1; attempt <= 3; attempt++) {
    transition(db, id, "in_progress", {});
    const callId = `call-${attempt}`;
    db.prepare("INSERT INTO call_attempts (call_id, booking_id, attempt_no, channel, started_at, transcript) VALUES (?, ?, ?, 'voice_agent', ?, '[]')").run(callId, id, attempt, now());
    finishAttempt(db, callId, id, attempt, { kind: "no_answer" });
    const s = bookingStatus(db, id)!;
    if (attempt < 3) assert.equal(s.state, "queued", `attempt ${attempt} should requeue`);
    else {
      assert.equal(s.state, "failed");
      assert.equal(s.failure_reason, "no_answer");
    }
  }
});

test("bad_data failure triggers immediate re-verification (REQ-ING-3)", () => {
  const db = testDb();
  const mid = insertMerchant(db);
  const id = bookOk(db, mid);
  transition(db, id, "in_progress", {});
  db.prepare("INSERT INTO call_attempts (call_id, booking_id, attempt_no, channel, started_at, transcript) VALUES ('c3', ?, 1, 'voice_agent', ?, '[]')").run(id, now());
  finishAttempt(db, "c3", id, 1, { kind: "failed", reason: "bad_data" });

  const m = db.prepare("SELECT phone_verified_at, verification_status FROM merchants WHERE merchant_id = ?").get(mid) as any;
  assert.equal(m.phone_verified_at, null);
  assert.equal(m.verification_status, "unverified");
});

test("cancel is allowed pre-terminal and post-confirmation, not after failure", () => {
  const db = testDb();
  const mid = insertMerchant(db);
  const a = bookOk(db, mid);
  assert.ok(cancelBooking(db, a, "changed plans").ok);
  assert.equal(bookingStatus(db, a)!.state, "cancelled");

  const b = bookOk(db, mid);
  transition(db, b, "in_progress", {});
  resolveFromCall(db, b, { kind: "confirmed", confirmed_time: "2026-07-18 19:00" });
  assert.ok(cancelBooking(db, b).ok);

  const c = bookOk(db, mid);
  transition(db, c, "in_progress", {});
  resolveFromCall(db, c, { kind: "failed", reason: "fully_booked" });
  assert.ok(!cancelBooking(db, c).ok);
});

test("feedback: only confirmed bookings, once per booking (REQ-FBK-1)", () => {
  const db = testDb();
  const mid = insertMerchant(db);
  const pending = bookOk(db, mid);
  assert.match(submitFeedback(db, { booking_id: pending, reservation_honored: true }).error!, /requires_confirmed/);

  const id = bookOk(db, mid);
  transition(db, id, "in_progress", {});
  resolveFromCall(db, id, { kind: "confirmed", confirmed_time: "2026-07-18 19:00" });

  const first = submitFeedback(db, { booking_id: id, reservation_honored: true, would_repeat: true, free_text: "great" });
  assert.ok(first.ok);
  assert.match(submitFeedback(db, { booking_id: id, reservation_honored: false }).error!, /already_submitted/);

  // transaction-verified upgrade on first feedback
  const m = db.prepare("SELECT verification_status FROM merchants WHERE merchant_id = ?").get(mid) as any;
  assert.equal(m.verification_status, "transaction_verified");
});

test("feedback free text length enforced", () => {
  const db = testDb();
  const mid = insertMerchant(db);
  const id = bookOk(db, mid);
  transition(db, id, "in_progress", {});
  resolveFromCall(db, id, { kind: "confirmed", confirmed_time: "2026-07-18 19:00" });
  assert.match(submitFeedback(db, { booking_id: id, reservation_honored: true, free_text: "x".repeat(600) }).error!, /too_long/);
});
