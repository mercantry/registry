# MCP Tool Reference

Written for agents first (REQ-MCP-6): every tool returns structured JSON with a published, versioned schema (`get_registry_meta.schema_version`). Breaking changes bump the version with a 90-day deprecation window (REQ-MCP-1).

Connect remotely over Streamable HTTP: `POST /mcp` on a deployed instance — live: `claude mcp add --transport http registry https://agentic-commerce-registry.fly.dev/mcp` (see [`deployment.md`](deployment.md)); optional developer key as `Authorization: Bearer reg_…` or `x-api-key`. Connect locally over stdio: `npm run mcp`. HTTP mirror of every tool lives at `/v1` (same JSON shapes; self-serve keys via `POST /v1/keys`; rate limits in `X-RateLimit-*` headers; bulk export at `GET /v1/export/merchants.ndjson`).

## Read tools

### `search_merchants`
Filter-based, **never ranked**. Deterministic order: `merchant_id` ASC by default; `distance` ASC (ties broken by `merchant_id`) when `lat`/`lng` supplied with `order_by: "distance"`.

Filters: `neighborhood`, `lat`+`lng`+`radius_km`, `cuisine_tags` (ANY-match), `attribute_tags` (ALL-match), `price_band_min/max`, `open_at`, `bookable_only`, `party_size`, `limit`/`offset`.

**Timezones (multi-city):** every merchant carries an IANA `timezone` (e.g. `Asia/Tokyo`); per-city zones are listed in `get_registry_meta.cities`. A naive ISO datetime anywhere in the API (`open_at`, booking `datetime`) means the **merchant's local wall time**; an explicit ISO-8601 offset (`2026-07-18T19:00:00+09:00` or trailing `Z`) pins the exact instant. Unparseable `open_at` returns `invalid_open_at`.

```json
{ "neighborhood": "Mission", "cuisine_tags": ["thai", "vietnamese"], "bookable_only": true, "party_size": 4 }
→ { "order": "merchant_id", "total": 11, "results": [ { "merchant_id": "…", "name": "…", "bookable": true, … } ] }
```

### `get_merchant`
Full signal dump: every schema field, structured hours + holiday exceptions, raw `feedback_history`, aggregate `feedback_summary`, platform-observed `operational_stats` (booking success rate, answer rate, avg confirmation time — computed from platform transactions only), and per-field `source_provenance` with timestamps. Maximal data, zero opinion.

### `get_availability`
**Honest v1 behavior:** the registry holds no live availability. Returns `availability_check: "performed_at_booking"` plus reservation policy and hours so the agent can pick a plausible slot. Availability is confirmed on the call.

### `get_registry_meta`
Per-city coverage (`cities`: name, IANA timezone, merchant count), bookable counts, verification/freshness stats (including how stale the data is), feedback corpus size, schema version, documented ordering rule. Lets agents evaluate the registry itself.

## Booking tools (async)

### `place_booking`
```json
{
  "merchant_id": "…",
  "party_size": 2,
  "datetime": "2026-07-18T19:00",
  "window_minutes": 60,
  "accept_within_window": true,
  "reservation_name": "Pat Doe",
  "contact": "pat@example.com",
  "special_requests": "Quiet table if possible",
  "callback_url": "https://your-agent.example/webhooks/registry",
  "client_reference_id": "d6f0a1e2-…"
}
→ { "ok": true, "booking_id": "…", "state": "queued" }
```
Fulfillment is asynchronous: a call is placed to the merchant (voice agent, human takeover available). `accept_within_window: true` is the recommended default — merchant counter-offers inside `±window_minutes` confirm without a round-trip (REQ-MCP-2). `datetime` is merchant-local when naive (see the timezone note above); an explicit offset is also accepted.

**Retry safety (idempotency):** always send a unique `client_reference_id` (a UUID is ideal; ≤128 chars; REST also accepts an `Idempotency-Key` header). If the call times out or errors ambiguously, retry with the **same** reference — the registry returns the already-created booking (`idempotent_replay: true`, REST 200) instead of double-booking the restaurant. Reusing a reference with *different* parameters is rejected (`client_reference_conflict`, REST 409); use a fresh reference for a genuinely new booking. References are scoped per developer key. Never re-call `place_booking` after a timeout without one.

### `get_booking_status`
State machine position: `pending → queued → in_progress → confirmed | failed | needs_input` (plus `cancelled`). Structured outcomes:
- `confirmed`: `confirmed_time`, `confirmation_code`, `merchant_instructions`
- `failed`: `failure_reason` ∈ `no_answer | fully_booked | closed | policy_mismatch | merchant_declined | bad_data | expired_sla | needs_input_timeout`
- `needs_input`: `needs_input_options` (merchant-offered times) + `needs_input_deadline`

Every status includes the merchant's `timezone` plus `requested_time_utc`/`confirmed_time_utc`, so merchant-local datetime strings are never ambiguous. Pass `include_events: true` for the full audit log. Prefer `callback_url` webhooks over polling (REQ-MCP-3); polling remains supported.

### `modify_booking`
Amend a queued booking, resolve `needs_input` (`accept_option_index` confirms an offered slot immediately), or change a confirmed booking (modeled as cancel + rebook; a new `booking_id` is returned).

### `cancel_booking`
**Mandatory when plans change.** No-shows destroy merchant trust and are tracked per developer key; high no-show developers get throttled. Cancelling a confirmed booking queues a notification call to the merchant.

## Feedback

### `submit_feedback`
Accepted only against a `confirmed` booking, once per booking, within 14 days (REQ-FBK-1). Structured fields first: `reservation_honored`, `seated_on_time`, `matched_description`, `would_repeat`, plus optional free text ≤ 500 chars. Served raw to all agents via `get_merchant` — never editorialized, never weighted into a platform score (REQ-FBK-3). First feedback upgrades the merchant to `transaction_verified`.

## Errors (machine-actionable by contract)

Every failure — MCP tool result or REST 4xx/5xx — is a structured object built to be self-corrected from:

```json
{"ok":false,"error":"party_size_out_of_range","field":"party_size","allowed":"1-8","message":"This merchant seats parties of 1-8.","docs":"https://<host>/v1/openapi.json"}
```

- **`error` is a stable machine code** — match on it exactly (`unknown_merchant`, `fulfillment_not_live`, `client_reference_conflict`, `invalid_datetime`, …). Codes never embed dynamic values; specifics live in `field` / `allowed` / `example` / `message`.
- **MCP**: error results set `isError: true` and the same JSON is the text content. **REST**: the HTTP status matches the code (404 unknown ids, 409 reference conflict, 401 bad key, 429 limits), and unknown `/v1` paths return `unknown_endpoint` JSON, never HTML.
- **429s teach backoff**: the `Retry-After` header plus `retry_after_s`/`limit`/`remaining`/`reset` in the body say exactly when to resume — applies to the per-minute rate limit (`rate_limited`) and key-minting caps (`key_minting_limit_*`, rolling 24h). Live state rides on every response in `X-RateLimit-*` headers.
- Full code catalog with statuses: `AgentError` schema + per-path responses in `/v1/openapi.json` (source: `src/registry/errors.ts`).

## Example transcript

```
agent → search_merchants {"neighborhood":"Hayes Valley","cuisine_tags":["japanese"],"bookable_only":true,"party_size":2}
      ← {"total":6,"order":"merchant_id","results":[…]}
agent → get_availability {"merchant_id":"a1b2…"}
      ← {"availability_check":"performed_at_booking","hours":[…],"reservation_policy":"accepts_reservations"}
agent → place_booking {"merchant_id":"a1b2…","party_size":2,"datetime":"2026-07-18T19:00","window_minutes":60,"accept_within_window":true,"reservation_name":"Pat Doe"}
      ← {"ok":true,"booking_id":"9f3c…","state":"queued"}
        …voice agent calls the restaurant; merchant offers 19:45; inside window → auto-accepted…
agent → get_booking_status {"booking_id":"9f3c…"}
      ← {"state":"confirmed","confirmed_time":"2026-07-18 19:45","confirmation_code":"K7M2PQ"}
        …after the meal…
agent → submit_feedback {"booking_id":"9f3c…","reservation_honored":true,"seated_on_time":true,"would_repeat":true}
      ← {"ok":true,"feedback_id":"…"}
```
