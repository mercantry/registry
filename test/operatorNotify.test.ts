/**
 * Note 004 phase 1 — operator notifications + per-channel SLA.
 * The "somehow let me know": one GitHub issue per real human_call booking,
 * closed with a disposition when the booking resolves. Notification is
 * best-effort and never touches booking state.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { placeBooking, channelSlaMs, bookingStatus } from "../src/orchestrator/bookings.js";
import { sweepOperatorNotifications } from "../src/orchestrator/operatorNotify.js";
import { transition } from "../src/orchestrator/stateMachine.js";
import { registryMeta } from "../src/registry/merchants.js";
import { testDb, insertMerchant } from "./helpers.js";

const NOTIFY = { repo: "example/warroom", token: "test-token" };

/** Let the sweep's fire-and-forget promise chains settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

type Call = { url: string; method: string; headers: Record<string, string>; payload: any };

function mockGithub(responder?: (url: string, method: string) => { status: number; body?: any }) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: any, init: any) => {
    const method = init?.method ?? "GET";
    const payload = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), method, headers: init?.headers ?? {}, payload });
    const r = responder?.(String(url), method) ?? { status: 201, body: { number: 101 } };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body ?? {},
    };
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function insertHumanCallBooking(db: any, merchantId: string, bookingId: string) {
  const at = new Date().toISOString();
  const sla = new Date(Date.now() + 86400_000).toISOString();
  db.prepare(
    `INSERT INTO bookings (booking_id, merchant_id, state, party_size, requested_time, window_minutes,
      accept_within_window, reservation_name, special_requests, attempts, sla_deadline, created_at, updated_at)
     VALUES (@id, @mid, 'pending', 4, '2026-07-26T19:30', 30, 1, 'Pat Doe', 'window table', 0, @sla, @at, @at)`,
  ).run({ id: bookingId, mid: merchantId, sla, at });
  transition(db, bookingId, "queued", {});
}

test("a real human_call booking opens a GitHub issue (once), storing the issue number", async () => {
  const db = testDb();
  const mid = insertMerchant(db, { sandbox: 0, fulfillment_channel: "human_call", name: "Kowloon Noodle House" });
  insertHumanCallBooking(db, mid, "bn-open-1");
  const { calls, fetchImpl } = mockGithub();

  sweepOperatorNotifications(db, { ...NOTIFY, fetchImpl });
  await settle();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.github.com/repos/example/warroom/issues");
  assert.equal(calls[0].headers.authorization, "Bearer test-token");
  assert.match(calls[0].payload.title, /Reservation request: Kowloon Noodle House · party of 4/);
  assert.match(calls[0].payload.body, /\+14155550100/); // operator needs the phone
  assert.doesNotMatch(calls[0].payload.body, /Pat Doe/); // end-human PII stays in the console

  const row = db.prepare("SELECT notify_issue_number FROM bookings WHERE booking_id = 'bn-open-1'").get() as any;
  assert.equal(row.notify_issue_number, 101);

  // Second sweep: nothing new to send.
  sweepOperatorNotifications(db, { ...NOTIFY, fetchImpl });
  await settle();
  assert.equal(calls.length, 1);
});

test("sandbox and non-human_call bookings do not notify (unless includeSandbox)", async () => {
  const db = testDb();
  const sandboxHuman = insertMerchant(db, { sandbox: 1, fulfillment_channel: "human_call" });
  const realVoice = insertMerchant(db, { sandbox: 0, fulfillment_channel: "voice_agent" });
  insertHumanCallBooking(db, sandboxHuman, "bn-sb-1");
  insertHumanCallBooking(db, realVoice, "bn-va-1");
  const { calls, fetchImpl } = mockGithub();

  sweepOperatorNotifications(db, { ...NOTIFY, fetchImpl });
  await settle();
  assert.equal(calls.length, 0);

  sweepOperatorNotifications(db, { ...NOTIFY, fetchImpl, includeSandbox: true });
  await settle();
  assert.equal(calls.length, 1); // the sandbox human_call one, flagged as a pipeline test
  assert.match(calls[0].payload.body, /sandbox — pipeline test/);
});

test("terminal state closes the issue with a disposition comment", async () => {
  const db = testDb();
  const mid = insertMerchant(db, { sandbox: 0, fulfillment_channel: "human_call" });
  insertHumanCallBooking(db, mid, "bn-close-1");
  const { calls, fetchImpl } = mockGithub();

  sweepOperatorNotifications(db, { ...NOTIFY, fetchImpl });
  await settle();
  db.prepare(
    "UPDATE bookings SET confirmed_time = '2026-07-26T19:30', confirmation_code = 'ABC234', updated_at = ? WHERE booking_id = 'bn-close-1'",
  ).run(new Date().toISOString());
  transition(db, "bn-close-1", "in_progress", {});
  transition(db, "bn-close-1", "confirmed", {});

  sweepOperatorNotifications(db, { ...NOTIFY, fetchImpl });
  await settle();

  const comment = calls.find((c) => c.url.endsWith("/issues/101/comments"));
  assert.ok(comment, "disposition comment posted");
  assert.match(comment!.payload.body, /Confirmed for 2026-07-26T19:30.*ABC234/);
  const close = calls.find((c) => c.method === "PATCH" && c.url.endsWith("/issues/101"));
  assert.ok(close, "issue closed");
  assert.equal(close!.payload.state, "closed");
  assert.equal(close!.payload.state_reason, "completed");
  const row = db.prepare("SELECT notify_issue_closed FROM bookings WHERE booking_id = 'bn-close-1'").get() as any;
  assert.equal(row.notify_issue_closed, 1);
});

test("a failed notification never touches booking state, logs, and backs off", async () => {
  const db = testDb();
  const mid = insertMerchant(db, { sandbox: 0, fulfillment_channel: "human_call" });
  insertHumanCallBooking(db, mid, "bn-fail-1");
  const { calls, fetchImpl } = mockGithub(() => ({ status: 500 }));

  sweepOperatorNotifications(db, { ...NOTIFY, fetchImpl });
  await settle();

  assert.equal(calls.length, 1);
  const row = db.prepare("SELECT state, notify_issue_number FROM bookings WHERE booking_id = 'bn-fail-1'").get() as any;
  assert.equal(row.state, "queued"); // booking unaffected
  assert.equal(row.notify_issue_number, null);
  const events = db
    .prepare("SELECT event FROM booking_events WHERE booking_id = 'bn-fail-1' AND event = 'operator_notify_failed'")
    .all();
  assert.equal(events.length, 1);

  // Immediate re-sweep is inside the backoff window — no API spam.
  sweepOperatorNotifications(db, { ...NOTIFY, fetchImpl });
  await settle();
  assert.equal(calls.length, 1);
});

test("sweep is a no-op without repo/token configured", async () => {
  const db = testDb();
  const mid = insertMerchant(db, { sandbox: 0, fulfillment_channel: "human_call" });
  insertHumanCallBooking(db, mid, "bn-off-1");
  const { calls, fetchImpl } = mockGithub();
  sweepOperatorNotifications(db, { fetchImpl }); // no repo/token
  await settle();
  assert.equal(calls.length, 0);
});

test("human_call bookings get the per-channel SLA; other channels keep REQ-FUL-6", () => {
  assert.equal(channelSlaMs("human_call"), config.fulfillment.channelSlaMs.human_call);
  assert.equal(channelSlaMs("voice_agent"), config.fulfillment.terminalSlaMs);
  assert.ok(channelSlaMs("human_call") > config.fulfillment.terminalSlaMs, "queue-until-worked SLA is longer");

  const db = testDb();
  const mid = insertMerchant(db, { sandbox: 1, fulfillment_channel: "human_call" });
  const res = placeBooking(db, { merchant_id: mid, party_size: 2, datetime: "2026-07-26T19:00", reservation_name: "Pat Doe" });
  assert.ok(res.ok, res.error);
  const s = bookingStatus(db, res.booking_id!)!;
  const slaMs = Date.parse(s.sla_deadline) - Date.now();
  assert.ok(Math.abs(slaMs - channelSlaMs("human_call")) < 10_000, `sla ${slaMs}ms ≈ human_call SLA`);
});

test("registry_meta publishes the operator window and channel liveness honestly", () => {
  const db = testDb();
  const meta = registryMeta(db) as any;
  assert.deepEqual([...meta.fulfillment.live_channels], []);
  assert.equal(meta.fulfillment.human_call.live, false);
  assert.equal(meta.fulfillment.human_call.operator_window, "12:00–23:00 Asia/Shanghai");
  assert.ok(meta.fulfillment.human_call.sla_hours > 0);
});
