/**
 * Feedback system (§6.4). Strict from day one:
 * REQ-FBK-1: only against confirmed bookings, once per booking, within 14 days.
 * REQ-FBK-2: structured-first; free text capped.
 * REQ-FBK-3: served raw + aggregate, never editorialized.
 */
import type { Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { now } from "../db/index.js";
import { config } from "../config.js";
import { getBooking } from "../orchestrator/bookings.js";
import { logEvent } from "../orchestrator/stateMachine.js";

type Row = Record<string, any>;

export interface FeedbackInput {
  booking_id: string;
  reservation_honored: boolean;
  seated_on_time?: boolean;
  matched_description?: boolean;
  would_repeat?: boolean;
  free_text?: string;
}

export function submitFeedback(
  db: Database,
  input: FeedbackInput,
): { ok: boolean; feedback_id?: string; error?: string } {
  const booking = getBooking(db, input.booking_id);
  if (!booking) return { ok: false, error: "unknown_booking" };
  if (booking.state !== "confirmed") return { ok: false, error: "feedback_requires_confirmed_booking" };

  const confirmedEvent = db
    .prepare(
      "SELECT at FROM booking_events WHERE booking_id = ? AND to_state = 'confirmed' ORDER BY id DESC LIMIT 1",
    )
    .get(input.booking_id) as Row | undefined;
  const confirmedAt = confirmedEvent ? new Date(confirmedEvent.at).getTime() : new Date(booking.created_at).getTime();
  if (Date.now() - confirmedAt > config.feedback.windowDays * 86400_000) {
    return { ok: false, error: `feedback_window_expired (${config.feedback.windowDays} days)` };
  }

  const existing = db
    .prepare("SELECT feedback_id FROM feedback_events WHERE booking_id = ?")
    .get(input.booking_id);
  if (existing) return { ok: false, error: "feedback_already_submitted" };

  if ((input.free_text ?? "").length > config.feedback.maxFreeTextChars) {
    return { ok: false, error: `free_text_too_long (max ${config.feedback.maxFreeTextChars} chars)` };
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO feedback_events (
      feedback_id, booking_id, merchant_id, submitted_at,
      reservation_honored, seated_on_time, matched_description, would_repeat, free_text
    ) VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.booking_id,
    booking.merchant_id,
    now(),
    input.reservation_honored ? 1 : 0,
    input.seated_on_time === undefined ? null : input.seated_on_time ? 1 : 0,
    input.matched_description === undefined ? null : input.matched_description ? 1 : 0,
    input.would_repeat === undefined ? null : input.would_repeat ? 1 : 0,
    input.free_text ?? null,
  );
  logEvent(db, input.booking_id, "tool_call", { tool: "submit_feedback", feedback_id: id });

  // First transaction-verified feedback upgrades the merchant's verification status.
  db.prepare(
    "UPDATE merchants SET verification_status = 'transaction_verified', updated_at = ? WHERE merchant_id = ? AND verification_status = 'phone_verified'",
  ).run(now(), booking.merchant_id);

  return { ok: true, feedback_id: id };
}

/** Raw feedback history for get_merchant (REQ-FBK-3: raw, never editorialized). */
export function feedbackHistory(db: Database, merchantId: string) {
  return db
    .prepare(
      `SELECT submitted_at, reservation_honored, seated_on_time, matched_description, would_repeat, free_text
       FROM feedback_events WHERE merchant_id = ? ORDER BY submitted_at DESC`,
    )
    .all(merchantId)
    .map((r: any) => ({
      submitted_at: r.submitted_at,
      reservation_honored: Boolean(r.reservation_honored),
      seated_on_time: r.seated_on_time === null ? null : Boolean(r.seated_on_time),
      matched_description: r.matched_description === null ? null : Boolean(r.matched_description),
      would_repeat: r.would_repeat === null ? null : Boolean(r.would_repeat),
      free_text: r.free_text,
    }));
}
