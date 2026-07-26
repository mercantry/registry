#!/usr/bin/env bash
# Mercantry — the full booking loop against a sandbox merchant, in curl.
#
#   ./booking-walkthrough.sh                       # against the live registry
#   ./booking-walkthrough.sh http://localhost:4100 # against your own instance
#
# WHAT YOU ARE BOOKING. Sandbox merchants are the permanent test set — the
# "Stripe test cards" of this API. They run the entire fulfillment state
# machine and return a SIMULATED confirmation; no real venue is ever dialed.
# Real merchants are discovery-only today: place_booking on one returns
# `fulfillment_not_live` (an honest refusal, not a bug) until human-operated
# fulfillment launches. Never show a sandbox confirmation to a user as a real
# reservation — the `sandbox` flag on every record is how you tell them apart.
set -euo pipefail

BASE="${1:-${REGISTRY_BASE:-https://agentic-commerce-registry.fly.dev}}"
POLL_SECONDS="${POLL_SECONDS:-90}"

# 1. Find a bookable sandbox merchant. Deterministic order, so this picks the
#    same one every run against the same corpus.
MERCHANT=$(curl -sS --get "$BASE/v1/merchants" \
  --data-urlencode "sandbox=true" \
  --data-urlencode "bookable_only=true" \
  --data-urlencode "party_size=2" \
  --data-urlencode "limit=1" | jq '.results[0] // empty')

if [ -z "$MERCHANT" ]; then
  echo "This deployment serves no bookable sandbox merchants — nothing to demo."
  exit 0
fi

MERCHANT_ID=$(jq -r '.merchant_id' <<<"$MERCHANT")
# Every merchant carries its own IANA zone. Where a record has none yet, the
# registry falls back to the deployment's default zone for naive datetimes —
# so read that from get_registry_meta rather than assuming UTC.
MERCHANT_TZ=$(jq -r '.timezone // empty' <<<"$MERCHANT")
if [ -z "$MERCHANT_TZ" ]; then
  MERCHANT_TZ=$(curl -sS "$BASE/v1/meta" | jq -r '.timezone // "UTC"')
fi
echo "sandbox merchant: $(jq -r '.name' <<<"$MERCHANT")  ($MERCHANT_ID, $MERCHANT_TZ)"

# 2. Pick a time. A naive datetime is the MERCHANT's local wall clock — never
#    yours, never UTC. (An explicit ISO-8601 offset, "…T19:00:00+09:00" or a
#    trailing Z, pins an exact instant instead.) Two hours out is deliberate:
#    bookings more than four hours ahead politely wait out the merchant's meal
#    rush before the call goes out, which is correct behavior and a slow demo.
#    GNU date shown; on BSD/macOS use: date -v+2H +%Y-%m-%dT%H:%M
WHEN=$(TZ="$MERCHANT_TZ" date -d '+2 hours' +%Y-%m-%dT%H:%M)

# 3. Place the booking. client_reference_id is the one field you should always
#    send: if this call times out or fails ambiguously, retrying with the SAME
#    value returns the booking that was already created (idempotent_replay:
#    true) instead of double-booking the restaurant. Reusing it with different
#    parameters is refused with client_reference_conflict (409) — use a fresh
#    value for a genuinely new booking. REST also accepts an Idempotency-Key
#    header; the body field wins if you send both.
REF="example-walkthrough-$(date +%s)-$RANDOM"

BOOKING=$(curl -sS -X POST "$BASE/v1/bookings" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg m "$MERCHANT_ID" --arg t "$WHEN" --arg ref "$REF" '{
        merchant_id: $m,
        party_size: 2,
        datetime: $t,
        window_minutes: 60,
        accept_within_window: true,
        reservation_name: "Example Runner",
        client_reference_id: $ref
      }')")

echo "--- place_booking ---"
jq '{ok, booking_id, state, idempotent_replay}' <<<"$BOOKING"

BOOKING_ID=$(jq -r '.booking_id // empty' <<<"$BOOKING")
if [ -z "$BOOKING_ID" ]; then
  # Errors are built to be self-corrected from: a stable machine `error` code,
  # the offending `field`, what would be `allowed`, and a docs URL.
  echo "booking refused:"; jq . <<<"$BOOKING"; exit 1
fi

# 3b. Proof of retry safety: the same reference returns the same booking.
REPLAY=$(curl -sS -X POST "$BASE/v1/bookings" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg m "$MERCHANT_ID" --arg t "$WHEN" --arg ref "$REF" '{
        merchant_id: $m, party_size: 2, datetime: $t, window_minutes: 60,
        accept_within_window: true, reservation_name: "Example Runner",
        client_reference_id: $ref
      }')")
echo "--- retry with the same client_reference_id ---"
jq '{booking_id, idempotent_replay}' <<<"$REPLAY"

# 4. Fulfillment is asynchronous: place_booking returns immediately and a call
#    is placed in the background. Poll get_booking_status, or (better) supply a
#    callback_url and receive state changes as webhooks — see webhook-receiver.js.
#    States: pending → queued → in_progress → confirmed | failed | needs_input
#    (plus cancelled). A counter-offer inside ±window_minutes auto-confirms
#    because accept_within_window was true; outside it, the booking parks in
#    needs_input with the merchant's offered times for you to resolve.
echo "--- polling get_booking_status (up to ${POLL_SECONDS}s) ---"
DEADLINE=$(( $(date +%s) + POLL_SECONDS ))
STATE=""
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  STATUS=$(curl -sS "$BASE/v1/bookings/$BOOKING_ID")
  STATE=$(jq -r '.state' <<<"$STATUS")
  echo "  state: $STATE"
  case "$STATE" in
    confirmed|failed|cancelled|needs_input) break ;;
  esac
  sleep 3
done

echo "--- final status ---"
curl -sS "$BASE/v1/bookings/$BOOKING_ID" | jq '{
  state, timezone, requested_time, requested_time_utc,
  confirmed_time, confirmed_time_utc, confirmation_code,
  failure_reason, needs_input_options
} | with_entries(select(.value != null))'

# Outcomes are drawn per booking, so a sandbox run can legitimately end in
# no_answer or fully_booked — that is the point: your error paths get
# exercised too. Pass include_events=true for the full audit log:
#   curl -sS "$BASE/v1/bookings/$BOOKING_ID?include_events=true" | jq '.events'

# 5. Cancel. Mandatory when plans change — no-shows are tracked per developer
#    key and heavy no-show callers get throttled. Cancelling a confirmed
#    booking queues a notification call to the merchant.
if [ "$STATE" != "failed" ] && [ "$STATE" != "cancelled" ]; then
  echo "--- cancel_booking ---"
  curl -sS -X POST "$BASE/v1/bookings/$BOOKING_ID/cancel" \
    -H 'content-type: application/json' \
    -d '{"reason":"example walkthrough finished"}' | jq '{ok, state}'
fi

# After a real confirmed booking is honored, close the loop with feedback —
# accepted once per booking, within 14 days, and served raw to every agent:
#   curl -sS -X POST "$BASE/v1/bookings/$BOOKING_ID/feedback" \
#     -H 'content-type: application/json' \
#     -d '{"reservation_honored":true,"seated_on_time":true,"would_repeat":true}'
