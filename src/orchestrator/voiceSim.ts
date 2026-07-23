/**
 * Simulated voice-agent driver.
 *
 * REQ-FUL-3 specifies a managed outbound calling stack (Retell/Vapi-class).
 * This module implements the same driver contract against a simulator so the
 * full loop — live transcript, human takeover, counter-offers, retries — is
 * exercisable without telephony. Swap `startVoiceCall` for the real driver
 * without touching the orchestrator.
 *
 * The transcript is appended to call_attempts.transcript line by line, which
 * is what the Ops Console live-monitors (REQ-FUL-4).
 */
import type { Database } from "better-sqlite3";
import { now } from "../db/index.js";
import { config } from "../config.js";

type Row = Record<string, any>;

export type CallOutcome =
  | { kind: "confirmed"; confirmed_time: string; merchant_instructions?: string }
  | { kind: "no_answer" }
  | { kind: "counter_offer"; offered_times: string[] }
  | { kind: "failed"; reason: "fully_booked" | "merchant_declined" | "bad_data" };

/** Deterministic 0..1 roll from booking id + attempt number, so runs are reproducible. */
export function outcomeRoll(bookingId: string, attemptNo: number): number {
  let h = 2166136261;
  const s = `${bookingId}:${attemptNo}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

export function pickOutcome(bookingId: string, attemptNo: number, requestedTime: string): CallOutcome {
  const roll = outcomeRoll(bookingId, attemptNo);
  const shift = (mins: number) => {
    const d = new Date(requestedTime.endsWith("Z") ? requestedTime : requestedTime + "Z");
    d.setUTCMinutes(d.getUTCMinutes() + mins);
    return d.toISOString().slice(0, 16).replace("T", " ");
  };
  if (roll < 0.12) return { kind: "no_answer" };
  if (roll < 0.7)
    return {
      kind: "confirmed",
      confirmed_time: requestedTime,
      merchant_instructions: roll < 0.25 ? "Table held 15 minutes past reservation time." : undefined,
    };
  if (roll < 0.85) return { kind: "counter_offer", offered_times: [shift(45), shift(90)] };
  if (roll < 0.93) return { kind: "failed", reason: "fully_booked" };
  if (roll < 0.97) return { kind: "failed", reason: "merchant_declined" };
  return { kind: "failed", reason: "bad_data" };
}

function scriptFor(merchantName: string, booking: Row, outcome: CallOutcome): { speaker: string; text: string }[] {
  const t = booking.requested_time.replace("T", " at ");
  const open = [
    { speaker: "merchant", text: `${merchantName}, good afternoon.` },
    {
      speaker: "voice_agent",
      // REQ-FUL-8: identify as a booking service calling on behalf of a customer.
      text: `Hi! I'm calling from Registry, a reservation service, booking on behalf of a customer. I'd like to request a table for ${booking.party_size} on ${t}, under the name ${booking.reservation_name}.`,
    },
  ];
  switch (outcome.kind) {
    case "confirmed":
      return [
        ...open,
        { speaker: "merchant", text: `Let me check... yes, we can do ${booking.party_size} at that time.` },
        { speaker: "voice_agent", text: `Wonderful. Confirming: ${booking.party_size} people, ${t}, under ${booking.reservation_name}.${booking.special_requests ? ` One note: ${booking.special_requests}.` : ""}` },
        { speaker: "merchant", text: `${outcome.merchant_instructions ?? "All set."} See you then.` },
        { speaker: "voice_agent", text: "Thank you very much. Goodbye!" },
      ];
    case "counter_offer":
      return [
        ...open,
        { speaker: "merchant", text: `That time is full. I could do ${outcome.offered_times[0]} or ${outcome.offered_times[1]}.` },
        { speaker: "voice_agent", text: "Let me check that against what the customer authorized..." },
      ];
    case "no_answer":
      return [{ speaker: "system", text: "Ringing... no answer after 45 seconds." }];
    case "failed":
      switch (outcome.reason) {
        case "fully_booked":
          return [...open, { speaker: "merchant", text: "I'm sorry, we're completely booked that evening." }, { speaker: "voice_agent", text: "Understood — thanks for checking. Have a good service!" }];
        case "merchant_declined":
          return [...open, { speaker: "merchant", text: "We're not taking phone reservations right now." }, { speaker: "voice_agent", text: "No problem, thank you for your time." }];
        case "bad_data":
          return [{ speaker: "system", text: "Number unreachable or reached a different business — flagging record for re-verification." }];
      }
  }
}

export interface VoiceCallHandle {
  callId: string;
  /** Resolves when the simulated call ends. Undefined outcome = human took over mid-call. */
  done: Promise<CallOutcome | undefined>;
}

export function appendTranscript(db: Database, callId: string, speaker: string, text: string) {
  const row = db.prepare("SELECT transcript FROM call_attempts WHERE call_id = ?").get(callId) as Row;
  const lines = JSON.parse(row.transcript);
  lines.push({ at: now(), speaker, text });
  db.prepare("UPDATE call_attempts SET transcript = ? WHERE call_id = ?").run(JSON.stringify(lines), callId);
}

/**
 * Drives a simulated call: emits transcript lines on a timer, checks for human
 * takeover between lines (REQ-FUL-4: one-click takeover), then resolves.
 */
export function startVoiceCall(
  db: Database,
  callId: string,
  merchantName: string,
  booking: Row,
  attemptNo: number,
): VoiceCallHandle {
  const outcome = pickOutcome(booking.booking_id, attemptNo, booking.requested_time);
  const lines = scriptFor(merchantName, booking, outcome);

  const done = new Promise<CallOutcome | undefined>((resolve) => {
    let i = 0;
    const tick = () => {
      const call = db.prepare("SELECT taken_over FROM call_attempts WHERE call_id = ?").get(callId) as Row | undefined;
      if (!call) return resolve(undefined);
      if (call.taken_over) {
        appendTranscript(db, callId, "system", "Human operator took over the call.");
        return resolve(undefined); // operator records the outcome via the ops console
      }
      if (i >= lines.length) return resolve(outcome);
      const line = lines[i++];
      appendTranscript(db, callId, line.speaker, line.text);
      setTimeout(tick, config.fulfillment.simLineDelayMs);
    };
    setTimeout(tick, config.fulfillment.simLineDelayMs);
  });

  return { callId, done };
}
