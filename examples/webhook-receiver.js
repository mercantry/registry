/**
 * Receive Mercantry booking state changes as webhooks instead of polling.
 *
 *   npm install express
 *   node webhook-receiver.js            # listens on :8787
 *
 * Then pass your public URL when you book:
 *   place_booking { ..., "callback_url": "https://your-agent.example/webhooks/registry" }
 *
 * Polling get_booking_status still works and is fully supported; webhooks just
 * spare you the loop. The registry has no server-initiated MCP stream — the
 * MCP endpoint is stateless POST-only — so this is the push path.
 */
import express from "express";

const app = express();
app.use(express.json());

const REGISTRY = process.env.REGISTRY_BASE ?? "https://agentic-commerce-registry.fly.dev";
const PORT = Number(process.env.PORT ?? 8787);

/** Terminal states: nothing further will arrive for this booking. */
const TERMINAL = new Set(["confirmed", "failed", "cancelled"]);

app.post("/webhooks/registry", async (req, res) => {
  // 1. Acknowledge immediately. Delivery is fire-and-forget: a slow or failing
  //    receiver is logged registry-side (webhook_failed on the booking's audit
  //    log) but not retried, so never do real work before responding.
  res.status(204).end();

  const event = req.body;
  if (event?.type !== "booking.state_changed") return;

  const { booking_id, from, to, at, booking } = event;
  console.log(`[${at}] ${booking_id}: ${from ?? "-"} → ${to}`);

  // 2. Payloads are NOT signed today — there is no shared secret and no
  //    signature header. Treat the delivery as a hint, not as truth: re-fetch
  //    the booking before you act on it or tell a user anything. Also use an
  //    unguessable callback path, and expect duplicates (be idempotent on
  //    booking_id + to-state).
  const verified = await fetch(`${REGISTRY}/v1/bookings/${booking_id}`).then((r) =>
    r.ok ? r.json() : null,
  );
  if (!verified || verified.state !== to) {
    console.warn(`  ignoring: registry says ${verified?.state ?? "unknown"}, not ${to}`);
    return;
  }

  // 3. Act on the verified state. `booking` in the payload is the same shape
  //    get_booking_status returns, so the two paths need no separate handling.
  switch (verified.state) {
    case "confirmed":
      // sandbox merchants return SIMULATED confirmations — check before you
      // tell a human they have a table.
      console.log(
        `  confirmed ${verified.confirmed_time} (${verified.timezone}) · code ${verified.confirmation_code}`,
      );
      break;
    case "needs_input":
      // The merchant offered alternatives outside your accept window. Resolve
      // with modify_booking { accept_option_index } before needs_input_deadline,
      // or it auto-fails.
      console.log(`  needs input by ${verified.needs_input_deadline}:`, verified.needs_input_options);
      break;
    case "failed":
      // Structured reason, never free text: no_answer | fully_booked | closed |
      // policy_mismatch | merchant_declined | bad_data | expired_sla |
      // needs_input_timeout.
      console.log(`  failed: ${verified.failure_reason}`);
      break;
    default:
      console.log(`  in flight (${verified.state})`);
  }

  if (TERMINAL.has(verified.state)) console.log(`  done with ${booking_id}`);
  void booking; // the pushed snapshot, kept for logging/debugging
});

app.listen(PORT, () => console.log(`listening for registry webhooks on :${PORT}/webhooks/registry`));
