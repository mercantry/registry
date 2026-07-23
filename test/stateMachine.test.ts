import { test } from "node:test";
import assert from "node:assert/strict";
import { canTransition, transition, isTerminal } from "../src/orchestrator/stateMachine.js";
import { placeBooking } from "../src/orchestrator/bookings.js";
import { testDb, insertMerchant } from "./helpers.js";

test("legal transition matrix matches REQ-FUL-1", () => {
  assert.ok(canTransition("pending", "queued"));
  assert.ok(canTransition("queued", "in_progress"));
  assert.ok(canTransition("in_progress", "confirmed"));
  assert.ok(canTransition("in_progress", "needs_input"));
  assert.ok(canTransition("in_progress", "queued")); // no_answer retry
  assert.ok(canTransition("needs_input", "confirmed")); // option accepted
  assert.ok(canTransition("confirmed", "cancelled")); // cancellation call
  assert.ok(!canTransition("failed", "queued")); // terminal is terminal
  assert.ok(!canTransition("cancelled", "confirmed"));
  assert.ok(!canTransition("pending", "confirmed")); // cannot skip the call
  assert.ok(isTerminal("failed") && isTerminal("confirmed") && isTerminal("cancelled"));
  assert.ok(!isTerminal("needs_input"));
});

test("transition writes an audited event and rejects illegal moves", () => {
  const db = testDb();
  const mid = insertMerchant(db);
  const res = placeBooking(db, {
    merchant_id: mid,
    party_size: 2,
    datetime: "2026-07-18T19:00",
    reservation_name: "Test Person",
  });
  assert.ok(res.ok);
  const id = res.booking_id!;
  assert.equal(res.state, "queued");

  transition(db, id, "in_progress", { call_id: "c1" });
  transition(db, id, "confirmed", { via: "call" });
  assert.throws(() => transition(db, id, "queued"), /Illegal/); // terminal states only allow confirmed→cancelled

  const events = db
    .prepare("SELECT * FROM booking_events WHERE booking_id = ? AND event = 'state_change' ORDER BY id")
    .all(id) as any[];
  assert.deepEqual(
    events.map((e) => e.to_state),
    ["queued", "in_progress", "confirmed"],
  );
  assert.ok(events.every((e) => e.at));
});
