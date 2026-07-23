/**
 * Fulfillment worker: routing (REQ-FUL-2), retries (REQ-FUL-6), SLA sweep,
 * needs_input timeout, call-window policy (REQ-FUL-5) and webhook dispatch
 * (REQ-MCP-3). Runs inside the API server process; ticks every 2 seconds.
 */
import type { Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { now } from "../db/index.js";
import { getMerchantRow, addProvenance } from "../registry/merchants.js";
import { logEvent, transition } from "./stateMachine.js";
import { bookingStatus, fulfillmentEligibility, resolveFromCall } from "./bookings.js";
import { startVoiceCall, type CallOutcome } from "./voiceSim.js";

type Row = Record<string, any>;

const activeCalls = new Set<string>(); // booking_ids with an in-flight simulated call in this process

/** REQ-FUL-5: avoid peak service windows for bookings >4h away (production mode only). */
export function inAvoidWindow(atLocalHHMM: string): { blocked: boolean; until?: string } {
  for (const w of config.fulfillment.avoidWindows) {
    if (atLocalHHMM >= w.start && atLocalHHMM < w.end) return { blocked: true, until: w.end };
  }
  return { blocked: false };
}

function localHHMM(): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: config.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
}

export function startWorker(db: Database, opts: { intervalMs?: number } = {}) {
  const interval = setInterval(() => tick(db), opts.intervalMs ?? 2000);
  interval.unref?.();
  return () => clearInterval(interval);
}

export function tick(db: Database) {
  dispatchQueued(db);
  sweepNeedsInputTimeouts(db);
  sweepSlaBreaches(db);
  dispatchWebhooks(db);
}

function dispatchQueued(db: Database) {
  const rows = db
    .prepare(
      "SELECT * FROM bookings WHERE state = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)",
    )
    .all(now()) as Row[];

  for (const booking of rows) {
    if (activeCalls.has(booking.booking_id)) continue;
    const merchant = getMerchantRow(db, booking.merchant_id);
    if (!merchant) continue;

    // Merchant opted out while booking was queued — hard exclusion (REQ-ING-4).
    if (merchant.opt_out) {
      db.prepare("UPDATE bookings SET failure_reason = 'merchant_declined', updated_at = ? WHERE booking_id = ?").run(now(), booking.booking_id);
      transition(db, booking.booking_id, "failed", { reason: "merchant_opted_out" });
      continue;
    }

    // Peak-window avoidance applies when the booking is >4h away (skipped in demo mode).
    if (!config.demoAccelerate) {
      const requestedMs = Date.parse(booking.requested_time + (booking.requested_time.endsWith("Z") ? "" : "Z"));
      if (requestedMs - Date.now() > config.fulfillment.peakAvoidanceHorizonMs) {
        const win = inAvoidWindow(localHHMM());
        if (win.blocked) {
          const today = new Date().toISOString().slice(0, 10);
          db.prepare("UPDATE bookings SET next_attempt_at = ? WHERE booking_id = ?").run(
            `${today}T${win.until}:00.000Z`,
            booking.booking_id,
          );
          continue;
        }
      }
    }

    // Booking guard (note 004): structural sim-safety backstop. If a non-sandbox
    // booking ever reaches the queue (should be blocked at place_booking), fail it
    // closed rather than dial a real merchant. voiceSim past this point is
    // sandbox-guaranteed.
    const elig = fulfillmentEligibility(merchant);
    if (!elig.ok) {
      db.prepare("UPDATE bookings SET failure_reason = ?, updated_at = ? WHERE booking_id = ?").run(elig.reason, now(), booking.booking_id);
      transition(db, booking.booking_id, "failed", { reason: elig.reason, guard: "worker" });
      continue;
    }
    // A real merchant on a live channel (future human_call tranche) is worked by an
    // operator via the ops console — never auto-dialed by voiceSim.
    if (!merchant.sandbox) continue;

    // REQ-FUL-2: routing policy. human_call bookings wait in the ops queue —
    // an operator claims them from the console; only voice_agent auto-dials.
    if (merchant.fulfillment_channel === "human_call") continue;

    startAttempt(db, booking, merchant);
  }
}

function startAttempt(db: Database, booking: Row, merchant: Row) {
  // Hard invariant: voiceSim NEVER dials a non-sandbox merchant. If any future
  // caller reaches here with a real merchant, refuse rather than place the call.
  if (!merchant.sandbox) {
    logEvent(db, booking.booking_id, "call_note", { error: "refused_voicesim_on_nonsandbox_merchant", merchant_id: merchant.merchant_id });
    return;
  }
  const attemptNo = booking.attempts + 1;
  const callId = randomUUID();
  db.prepare(
    "INSERT INTO call_attempts (call_id, booking_id, attempt_no, channel, started_at, transcript) VALUES (?,?,?,?,?,'[]')",
  ).run(callId, booking.booking_id, attemptNo, "voice_agent", now());
  db.prepare("UPDATE bookings SET attempts = ?, next_attempt_at = NULL, updated_at = ? WHERE booking_id = ?").run(
    attemptNo,
    now(),
    booking.booking_id,
  );
  transition(db, booking.booking_id, "in_progress", { call_id: callId, attempt: attemptNo, channel: "voice_agent" });

  activeCalls.add(booking.booking_id);
  const handle = startVoiceCall(db, callId, merchant.name, booking, attemptNo);
  handle.done
    .then((outcome) => {
      activeCalls.delete(booking.booking_id);
      if (outcome === undefined) return; // human takeover: operator resolves via ops console
      finishAttempt(db, callId, booking.booking_id, attemptNo, outcome);
    })
    .catch((err) => {
      activeCalls.delete(booking.booking_id);
      logEvent(db, booking.booking_id, "call_note", { error: String(err) });
    });
}

export function finishAttempt(
  db: Database,
  callId: string,
  bookingId: string,
  attemptNo: number,
  outcome: CallOutcome,
) {
  const booking = db.prepare("SELECT * FROM bookings WHERE booking_id = ?").get(bookingId) as Row;
  if (!booking || booking.state !== "in_progress") return;

  const endCall = (result: string) =>
    db.prepare("UPDATE call_attempts SET ended_at = ?, outcome = ? WHERE call_id = ?").run(now(), result, callId);

  switch (outcome.kind) {
    case "confirmed":
      endCall("confirmed");
      resolveFromCall(db, bookingId, {
        kind: "confirmed",
        confirmed_time: outcome.confirmed_time,
        merchant_instructions: outcome.merchant_instructions,
      });
      relayConfirmation(db, bookingId);
      break;

    case "no_answer": {
      endCall("no_answer");
      if (attemptNo >= config.fulfillment.maxCallAttempts) {
        db.prepare("UPDATE bookings SET failure_reason = 'no_answer', updated_at = ? WHERE booking_id = ?").run(now(), bookingId);
        transition(db, bookingId, "failed", { reason: "no_answer", attempts: attemptNo });
      } else {
        const nextAt = new Date(Date.now() + config.fulfillment.retryDelayMs).toISOString();
        db.prepare("UPDATE bookings SET next_attempt_at = ?, updated_at = ? WHERE booking_id = ?").run(nextAt, now(), bookingId);
        transition(db, bookingId, "queued", { reason: "no_answer_retry", next_attempt_at: nextAt });
      }
      break;
    }

    case "counter_offer": {
      endCall("counter_offer");
      // REQ-MCP-2: auto-accept if the merchant's offer falls inside the agent-authorized window.
      const window = booking.window_minutes ?? 0;
      const requested = Date.parse(booking.requested_time + (booking.requested_time.endsWith("Z") ? "" : "Z"));
      const within = outcome.offered_times.find((t) => {
        const offered = Date.parse(t.replace(" ", "T") + "Z");
        return Math.abs(offered - requested) <= window * 60_000;
      });
      if (booking.accept_within_window && within) {
        logEvent(db, bookingId, "call_note", { auto_accepted: within, rule: "accept_within_window" });
        resolveFromCall(db, bookingId, { kind: "confirmed", confirmed_time: within });
        relayConfirmation(db, bookingId);
      } else {
        resolveFromCall(db, bookingId, {
          kind: "needs_input",
          options: outcome.offered_times.map((t) => ({ time: t, note: "offered by merchant on call" })),
        });
      }
      break;
    }

    case "failed": {
      endCall(outcome.reason);
      db.prepare("UPDATE bookings SET failure_reason = ?, updated_at = ? WHERE booking_id = ?").run(outcome.reason, now(), bookingId);
      transition(db, bookingId, "failed", { reason: outcome.reason });
      if (outcome.reason === "bad_data") {
        // REQ-ING-3: a failed call due to bad data triggers immediate re-verification.
        db.prepare("UPDATE merchants SET phone_verified_at = NULL, verification_status = 'unverified', updated_at = ? WHERE merchant_id = ?").run(now(), booking.merchant_id);
        addProvenance(db, booking.merchant_id, "phone_primary", "failed_booking_call", `booking ${bookingId}: number unreachable — queued for re-verification`);
      }
      break;
    }
  }
}

/** REQ-FUL-7: confirmation relay — structured details to the agent; optional SMS/email to the end human. */
function relayConfirmation(db: Database, bookingId: string) {
  const b = db.prepare("SELECT contact, confirmation_code FROM bookings WHERE booking_id = ?").get(bookingId) as Row;
  if (b?.contact) {
    // v1 scaffold: log the relay; production wires an SMS/email provider here.
    logEvent(db, bookingId, "confirmation_relay", {
      channel: b.contact.includes("@") ? "email" : "sms",
      to: "(stored contact)",
      code: b.confirmation_code,
    });
  }
}

function sweepNeedsInputTimeouts(db: Database) {
  const rows = db
    .prepare("SELECT booking_id FROM bookings WHERE state = 'needs_input' AND needs_input_deadline <= ?")
    .all(now()) as Row[];
  for (const r of rows) {
    db.prepare("UPDATE bookings SET failure_reason = 'needs_input_timeout', updated_at = ? WHERE booking_id = ?").run(now(), r.booking_id);
    transition(db, r.booking_id, "failed", { reason: "needs_input_timeout" });
  }
}

/** REQ-FUL-6: all bookings resolve to a terminal state within the SLA or auto-fail with reason. */
function sweepSlaBreaches(db: Database) {
  const rows = db
    .prepare(
      "SELECT booking_id, state FROM bookings WHERE state IN ('pending','queued','needs_input') AND sla_deadline <= ?",
    )
    .all(now()) as Row[];
  for (const r of rows) {
    db.prepare("UPDATE bookings SET failure_reason = 'expired_sla', updated_at = ? WHERE booking_id = ?").run(now(), r.booking_id);
    transition(db, r.booking_id, "failed", { reason: "expired_sla" });
  }
}

/**
 * REQ-MCP-3: webhook dispatch on state changes. Scans the audit log so it
 * catches transitions from every process sharing the DB (worker, ops API, MCP).
 */
function dispatchWebhooks(db: Database) {
  const events = db
    .prepare(
      `SELECT e.id, e.booking_id, e.from_state, e.to_state, e.at, b.callback_url
       FROM booking_events e JOIN bookings b ON b.booking_id = e.booking_id
       WHERE e.event = 'state_change' AND e.dispatched = 0
       ORDER BY e.id LIMIT 50`,
    )
    .all() as Row[];

  for (const ev of events) {
    db.prepare("UPDATE booking_events SET dispatched = 1 WHERE id = ?").run(ev.id);
    if (!ev.callback_url) continue;
    const payload = {
      type: "booking.state_changed",
      booking_id: ev.booking_id,
      from: ev.from_state,
      to: ev.to_state,
      at: ev.at,
      booking: bookingStatus(db, ev.booking_id),
    };
    fetch(ev.callback_url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then((res) => logEvent(db, ev.booking_id, "webhook_sent", { url: ev.callback_url, status: res.status }))
      .catch((err) => logEvent(db, ev.booking_id, "webhook_failed", { url: ev.callback_url, error: String(err) }));
  }
}
