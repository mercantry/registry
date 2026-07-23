import type { Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { now } from "../db/index.js";
import { config } from "../config.js";
import { deriveBookable, getMerchantRow } from "../registry/merchants.js";
import { logEvent, transition } from "./stateMachine.js";
import type { BookingState } from "../registry/types.js";

type Row = Record<string, any>;

export interface PlaceBookingInput {
  merchant_id: string;
  party_size: number;
  datetime: string; // ISO local datetime
  window_minutes?: number;
  accept_within_window?: boolean;
  reservation_name: string;
  contact?: string;
  special_requests?: string;
  callback_url?: string;
  api_key_id?: string;
}

export interface PlaceBookingResult {
  ok: boolean;
  booking_id?: string;
  state?: BookingState;
  error?: string;
}

/**
 * Booking guard (note 004 discovery-only cutover). The hard sim-safety rule:
 * voiceSim may only ever dial SANDBOX merchants. Real merchants are served for
 * discovery (search/read) but are not fulfillable until the human-operator flow
 * is live — gated by config.fulfillment.liveChannels (empty until note 004 ships).
 *
 * This is defense in depth beyond the `bookable` derivation: a real merchant
 * that somehow became phone-verified still cannot be booked here.
 */
export function fulfillmentEligibility(merchant: Row): { ok: boolean; reason?: string } {
  if (merchant.sandbox) return { ok: true }; // safe to dial via voiceSim
  if (config.fulfillment.liveChannels.includes(merchant.fulfillment_channel)) return { ok: true };
  return { ok: false, reason: "fulfillment_not_live" };
}

export function placeBooking(db: Database, input: PlaceBookingInput): PlaceBookingResult {
  const merchant = getMerchantRow(db, input.merchant_id);
  if (!merchant) return { ok: false, error: "unknown_merchant" };
  // Booking guard first, so a real merchant returns the honest `fulfillment_not_live`
  // rather than an incidental `merchant_not_phone_verified`.
  const elig = fulfillmentEligibility(merchant);
  if (!elig.ok) return { ok: false, error: elig.reason };
  if (!deriveBookable(merchant as any)) {
    const reason = merchant.opt_out
      ? "merchant_opted_out"
      : merchant.requires_deposit
        ? "requires_deposit_not_supported_in_v1"
        : !merchant.phone_verified_at
          ? "merchant_not_phone_verified"
          : "reservation_policy_not_bookable";
    return { ok: false, error: reason };
  }
  if (input.party_size < 1 || input.party_size > merchant.max_party_size) {
    return { ok: false, error: `party_size_out_of_range (max ${merchant.max_party_size})` };
  }
  if ((input.special_requests ?? "").length > config.mcp.specialRequestMaxChars) {
    return { ok: false, error: `special_requests_too_long (max ${config.mcp.specialRequestMaxChars} chars)` };
  }
  if (Number.isNaN(Date.parse(input.datetime))) {
    return { ok: false, error: "invalid_datetime" };
  }

  const bookingId = randomUUID();
  const at = now();
  const sla = new Date(Date.now() + config.fulfillment.terminalSlaMs).toISOString();

  db.prepare(
    `INSERT INTO bookings (
      booking_id, merchant_id, api_key_id, state, party_size, requested_time,
      window_minutes, accept_within_window, reservation_name, contact,
      special_requests, callback_url, attempts, sla_deadline, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)`,
  ).run(
    bookingId,
    input.merchant_id,
    input.api_key_id ?? null,
    "pending",
    input.party_size,
    input.datetime,
    input.window_minutes ?? 0,
    input.accept_within_window ? 1 : 0,
    input.reservation_name,
    input.contact ?? null,
    input.special_requests ?? null,
    input.callback_url ?? null,
    sla,
    at,
    at,
  );
  logEvent(db, bookingId, "tool_call", { tool: "place_booking", input: { ...input } });

  // Accept into the fulfillment queue immediately; the worker picks it up.
  transition(db, bookingId, "queued", { reason: "accepted_by_orchestrator" });
  return { ok: true, booking_id: bookingId, state: "queued" };
}

export function getBooking(db: Database, bookingId: string): Row | undefined {
  return db.prepare("SELECT * FROM bookings WHERE booking_id = ?").get(bookingId) as Row | undefined;
}

export function getBookingEvents(db: Database, bookingId: string): Row[] {
  return db
    .prepare("SELECT at, event, from_state, to_state, detail FROM booking_events WHERE booking_id = ? ORDER BY id")
    .all(bookingId) as Row[];
}

/** Agent-facing status view (get_booking_status). */
export function bookingStatus(db: Database, bookingId: string) {
  const b = getBooking(db, bookingId);
  if (!b) return null;
  return {
    booking_id: b.booking_id,
    merchant_id: b.merchant_id,
    state: b.state,
    failure_reason: b.failure_reason ?? undefined,
    requested_time: b.requested_time,
    window_minutes: b.window_minutes,
    party_size: b.party_size,
    confirmed_time: b.confirmed_time ?? undefined,
    confirmation_code: b.confirmation_code ?? undefined,
    merchant_instructions: b.merchant_instructions ?? undefined,
    needs_input_options: b.needs_input_options ? JSON.parse(b.needs_input_options) : undefined,
    needs_input_deadline: b.needs_input_deadline ?? undefined,
    attempts: b.attempts,
    sla_deadline: b.sla_deadline,
    created_at: b.created_at,
    updated_at: b.updated_at,
  };
}

/**
 * modify_booking (REQ-MCP-2): also the resolution path for needs_input —
 * the agent either amends the request (new time/party size) or accepts an
 * offered option by index.
 */
export function modifyBooking(
  db: Database,
  bookingId: string,
  changes: {
    datetime?: string;
    party_size?: number;
    window_minutes?: number;
    accept_option_index?: number;
  },
): { ok: boolean; state?: BookingState; error?: string } {
  const b = getBooking(db, bookingId);
  if (!b) return { ok: false, error: "unknown_booking" };

  if (b.state === "needs_input" && changes.accept_option_index !== undefined) {
    const options = b.needs_input_options ? JSON.parse(b.needs_input_options) : [];
    const opt = options[changes.accept_option_index];
    if (!opt) return { ok: false, error: "invalid_option_index" };
    // Merchant already offered this slot on the call — accepting it confirms directly.
    const code = makeConfirmationCode();
    db.prepare(
      "UPDATE bookings SET confirmed_time = ?, confirmation_code = ?, needs_input_options = NULL, needs_input_deadline = NULL, updated_at = ? WHERE booking_id = ?",
    ).run(opt.time, code, now(), bookingId);
    logEvent(db, bookingId, "tool_call", { tool: "modify_booking", accepted_option: opt });
    transition(db, bookingId, "confirmed", { via: "needs_input_option_accepted", option: opt });
    return { ok: true, state: "confirmed" };
  }

  if (b.state === "confirmed" || b.state === "failed" || b.state === "cancelled") {
    if (b.state !== "confirmed") return { ok: false, error: `booking_in_terminal_state (${b.state})` };
    // Modifying a confirmed booking requires a new call to the merchant.
    db.prepare(
      "UPDATE bookings SET requested_time = COALESCE(?, requested_time), party_size = COALESCE(?, party_size), window_minutes = COALESCE(?, window_minutes), confirmed_time = NULL, confirmation_code = NULL, attempts = 0, next_attempt_at = NULL, sla_deadline = ?, updated_at = ? WHERE booking_id = ?",
    ).run(
      changes.datetime ?? null,
      changes.party_size ?? null,
      changes.window_minutes ?? null,
      new Date(Date.now() + config.fulfillment.terminalSlaMs).toISOString(),
      now(),
      bookingId,
    );
    logEvent(db, bookingId, "tool_call", { tool: "modify_booking", changes, note: "re-queued for modification call" });
    transition(db, bookingId, "cancelled", { via: "superseded_by_modification" });
    // A modification of a confirmed booking is modeled as cancel + rebook to keep the audit trail honest.
    const rebook = placeBooking(db, {
      merchant_id: b.merchant_id,
      party_size: changes.party_size ?? b.party_size,
      datetime: changes.datetime ?? b.requested_time,
      window_minutes: changes.window_minutes ?? b.window_minutes,
      accept_within_window: Boolean(b.accept_within_window),
      reservation_name: b.reservation_name,
      contact: b.contact ?? undefined,
      special_requests: b.special_requests ?? undefined,
      callback_url: b.callback_url ?? undefined,
      api_key_id: b.api_key_id ?? undefined,
    });
    logEvent(db, bookingId, "call_note", { superseded_by: rebook.booking_id });
    return { ok: true, state: "queued", ...(rebook.booking_id ? { new_booking_id: rebook.booking_id } as any : {}) };
  }

  // Pre-call amendment: just update the request.
  db.prepare(
    "UPDATE bookings SET requested_time = COALESCE(?, requested_time), party_size = COALESCE(?, party_size), window_minutes = COALESCE(?, window_minutes), needs_input_options = NULL, needs_input_deadline = NULL, updated_at = ? WHERE booking_id = ?",
  ).run(changes.datetime ?? null, changes.party_size ?? null, changes.window_minutes ?? null, now(), bookingId);
  logEvent(db, bookingId, "tool_call", { tool: "modify_booking", changes });
  if (b.state === "needs_input") transition(db, bookingId, "queued", { via: "amended_after_needs_input" });
  return { ok: true, state: (getBooking(db, bookingId) as Row).state };
}

/** cancel_booking — mandatory in v1 (no-shows poison merchant trust). */
export function cancelBooking(
  db: Database,
  bookingId: string,
  reason?: string,
): { ok: boolean; state?: BookingState; error?: string } {
  const b = getBooking(db, bookingId);
  if (!b) return { ok: false, error: "unknown_booking" };
  if (b.state === "failed" || b.state === "cancelled")
    return { ok: false, error: `booking_in_terminal_state (${b.state})` };

  const wasConfirmed = b.state === "confirmed";
  logEvent(db, bookingId, "tool_call", { tool: "cancel_booking", reason });
  transition(db, bookingId, "cancelled", {
    reason: reason ?? "agent_requested",
    ...(wasConfirmed ? { note: "cancellation call to merchant queued" } : {}),
  });
  if (wasConfirmed) {
    // Real cancellation requires telling the merchant; log the follow-up call task.
    logEvent(db, bookingId, "call_note", {
      task: "cancellation_call",
      detail: "ops to notify merchant of cancellation",
    });
  }
  return { ok: true, state: "cancelled" };
}

export function makeConfirmationCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

/** Ops/worker helper: record a terminal outcome coming from a call. */
export function resolveFromCall(
  db: Database,
  bookingId: string,
  outcome:
    | { kind: "confirmed"; confirmed_time: string; merchant_instructions?: string }
    | { kind: "failed"; reason: string; note?: string }
    | { kind: "needs_input"; options: { time: string; note?: string }[] },
) {
  const at = now();
  if (outcome.kind === "confirmed") {
    db.prepare(
      "UPDATE bookings SET confirmed_time = ?, confirmation_code = ?, merchant_instructions = ?, updated_at = ? WHERE booking_id = ?",
    ).run(outcome.confirmed_time, makeConfirmationCode(), outcome.merchant_instructions ?? null, at, bookingId);
    transition(db, bookingId, "confirmed", { via: "call" });
  } else if (outcome.kind === "failed") {
    db.prepare("UPDATE bookings SET failure_reason = ?, updated_at = ? WHERE booking_id = ?").run(
      outcome.reason,
      at,
      bookingId,
    );
    transition(db, bookingId, "failed", { reason: outcome.reason, note: outcome.note });
  } else {
    const deadline = new Date(Date.now() + config.fulfillment.needsInputTimeoutMs).toISOString();
    db.prepare(
      "UPDATE bookings SET needs_input_options = ?, needs_input_deadline = ?, updated_at = ? WHERE booking_id = ?",
    ).run(JSON.stringify(outcome.options), deadline, at, bookingId);
    transition(db, bookingId, "needs_input", { options: outcome.options, deadline });
  }
}
