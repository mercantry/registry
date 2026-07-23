import { test } from "node:test";
import assert from "node:assert/strict";
import { publicStats } from "../src/api/stats.js";
import { testDb, insertMerchant } from "./helpers.js";
import { placeBooking } from "../src/orchestrator/bookings.js";

test("publicStats aggregates the booking funnel without PII", () => {
  const db = testDb();
  const merchant = insertMerchant(db);
  const r = placeBooking(db, {
    merchant_id: merchant,
    party_size: 2,
    datetime: "2026-07-20T19:00",
    reservation_name: "Private Person",
  });
  assert.ok(r.ok);

  const s = publicStats(db);
  assert.equal(s.bookings.total, 1);
  assert.equal(s.bookings.by_state.queued, 1);
  assert.equal(s.feedback_count, 0);
  // PII must never leak into the public stats payload.
  assert.ok(!JSON.stringify(s).includes("Private Person"));
  // Queue-age monitoring (note 004): the fresh booking is the oldest active.
  assert.ok(s.queue.oldest_active_minutes !== null && s.queue.oldest_active_minutes <= 1);
});

test("human_call queue depth is tracked for the part-time operator", () => {
  const db = testDb();
  const merchant = insertMerchant(db, { fulfillment_channel: "human_call" });
  const r = placeBooking(db, {
    merchant_id: merchant,
    party_size: 4,
    datetime: "2026-07-21T19:00",
    reservation_name: "Queue Test",
  });
  assert.ok(r.ok);
  const s = publicStats(db);
  assert.equal(s.queue.human_call.queued, 1);
  assert.ok(s.queue.human_call.oldest_queued_minutes !== null);
});
