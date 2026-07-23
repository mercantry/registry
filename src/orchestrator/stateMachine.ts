/**
 * Booking state machine (REQ-FUL-1).
 *
 *   pending → queued → in_progress → confirmed | failed | needs_input
 *                ↑           |
 *                └───────────┘  (no_answer retry, REQ-FUL-6)
 *   needs_input → queued (agent resolves) | failed (timeout)
 *   any non-terminal → cancelled; confirmed → cancelled (cancellation call)
 *
 * Every transition is written to booking_events with a timestamp (auditability NFR).
 */
import type { Database } from "better-sqlite3";
import { now } from "../db/index.js";
import type { BookingState } from "../registry/types.js";
import { TERMINAL_STATES } from "../registry/types.js";

const ALLOWED: Record<BookingState, BookingState[]> = {
  pending: ["queued", "cancelled", "failed"],
  queued: ["in_progress", "cancelled", "failed"],
  in_progress: ["confirmed", "failed", "needs_input", "queued", "cancelled"],
  needs_input: ["queued", "failed", "cancelled", "confirmed"],
  confirmed: ["cancelled"],
  failed: [],
  cancelled: [],
};

export function isTerminal(state: BookingState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function canTransition(from: BookingState, to: BookingState): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}

export function logEvent(
  db: Database,
  bookingId: string,
  event: string,
  detail?: unknown,
  fromState?: string,
  toState?: string,
) {
  db.prepare(
    "INSERT INTO booking_events (booking_id, at, event, from_state, to_state, detail) VALUES (?,?,?,?,?,?)",
  ).run(
    bookingId,
    now(),
    event,
    fromState ?? null,
    toState ?? null,
    detail === undefined ? null : JSON.stringify(detail),
  );
}

/**
 * Atomically transition a booking. Throws on illegal transitions so bugs
 * surface as errors, never as silently corrupted state.
 */
export function transition(
  db: Database,
  bookingId: string,
  to: BookingState,
  detail?: Record<string, unknown>,
): { from: BookingState; to: BookingState } {
  const run = db.transaction(() => {
    const row = db
      .prepare("SELECT state FROM bookings WHERE booking_id = ?")
      .get(bookingId) as { state: BookingState } | undefined;
    if (!row) throw new Error(`Unknown booking: ${bookingId}`);
    const from = row.state;
    if (!canTransition(from, to)) {
      throw new Error(`Illegal transition ${from} → ${to} for booking ${bookingId}`);
    }
    db.prepare("UPDATE bookings SET state = ?, updated_at = ? WHERE booking_id = ?").run(
      to,
      now(),
      bookingId,
    );
    logEvent(db, bookingId, "state_change", detail, from, to);
    return { from, to };
  });
  return run();
}
