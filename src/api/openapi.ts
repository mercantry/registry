/**
 * Machine-readable self-description of the /v1 REST surface (OpenAPI 3.1).
 *
 * Machine-surfaces principle: what a
 * connecting agent reads first — self-describing services get re-selected.
 * Served at GET /v1/openapi.json; GET /v1 returns a compact index pointing
 * here. The MCP surface at /mcp self-describes via tools/list already; this
 * gives the REST mirror the same property.
 *
 * House rules apply: honest descriptions, documented deterministic ordering,
 * no ranking language anywhere (REQ-DATA-2).
 */
import { config } from "../config.js";

const merchantSummary = {
  type: "object",
  description: "Compact merchant record returned by search. Deterministic order, never ranked.",
  properties: {
    merchant_id: { type: "string", format: "uuid" },
    name: { type: "string" },
    cuisine_tags: { type: "array", items: { type: "string" } },
    attribute_tags: { type: "array", items: { type: "string" } },
    neighborhood: { type: "string" },
    address: { type: "string" },
    lat: { type: "number" },
    lng: { type: "number" },
    price_band: { type: "integer", minimum: 1, maximum: 4 },
    reservation_policy: {
      type: "string",
      enum: ["walk_in_only", "phone_reservations", "accepts_reservations", "requires_deposit"],
    },
    bookable: {
      type: "boolean",
      description: "Derived: phone-verified AND accepts phone reservations AND not opted out AND no deposit required.",
    },
    verification_status: { type: "string", enum: ["unverified", "phone_verified", "transaction_verified"] },
    distance_km: { type: "number", description: "Present only when a geo filter was supplied." },
  },
} as const;

const agentError = {
  type: "object",
  description:
    "Agent-actionable error, returned on every 4xx/5xx. `error` is a stable machine code — match on it exactly. Where known, `field` names the offending input, `allowed`/`example` say what would be accepted, `message` explains the fix, and `docs` links this document. 429s additionally set the Retry-After header and `retry_after_s`.",
  required: ["error"],
  properties: {
    ok: { type: "boolean", const: false },
    error: { type: "string", description: "Stable machine code, e.g. party_size_out_of_range, unknown_merchant, rate_limited." },
    message: { type: "string", description: "What went wrong and what to do instead." },
    field: { type: "string", description: "The offending request field, when the error is input-specific." },
    allowed: { type: "string", description: "Accepted values/range for `field`, e.g. '1-8'." },
    example: { type: "string", description: "An example of an accepted value." },
    docs: { type: "string", description: "URL of this OpenAPI document." },
    retry_after_s: { type: "integer", description: "Seconds to wait before retrying (429 only; mirrors the Retry-After header)." },
  },
} as const;

const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/AgentError" } } },
});

const bookingStatus = {
  type: "object",
  description: "Booking state machine position with structured outcome details.",
  properties: {
    booking_id: { type: "string", format: "uuid" },
    merchant_id: { type: "string", format: "uuid" },
    state: {
      type: "string",
      enum: ["pending", "queued", "in_progress", "needs_input", "confirmed", "failed", "cancelled"],
    },
    failure_reason: {
      type: "string",
      enum: ["no_answer", "fully_booked", "closed", "policy_mismatch", "merchant_declined", "bad_data", "expired_sla", "needs_input_timeout"],
    },
    requested_time: { type: "string" },
    window_minutes: { type: "integer" },
    party_size: { type: "integer" },
    confirmed_time: { type: "string" },
    confirmation_code: { type: "string" },
    merchant_instructions: { type: "string" },
    needs_input_options: {
      type: "array",
      items: { type: "object", properties: { time: { type: "string" }, note: { type: "string" } } },
      description: "Merchant-offered alternatives awaiting the agent's decision (resolve via /v1/bookings/{id}/modify).",
    },
    needs_input_deadline: { type: "string" },
    attempts: { type: "integer" },
    sla_deadline: { type: "string", description: "Terminal state guaranteed by this time (REQ-FUL-6)." },
    created_at: { type: "string" },
    updated_at: { type: "string" },
  },
} as const;

export function buildOpenApi(baseUrl: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Registry — agent-native merchant registry (REST mirror)",
      version: config.schemaVersion,
      description:
        `Structured merchant data and phone-fulfilled restaurant reservations for AI agents. ${config.launchCity}, ~500 merchants. ` +
        "This REST surface mirrors the MCP server at POST /mcp (Streamable HTTP) — same data, same booking state machine. " +
        "Honest by design: filter-based search in deterministic order (never ranked), transaction-verified feedback only, " +
        "availability checked on the call at booking time (`performed_at_booking`). " +
        "Reads are free and unauthenticated; API keys are optional and exist for abuse control, not gating. " +
        "Errors are machine-actionable: every 4xx/5xx body carries a stable `error` code plus `field`/`allowed`/`example`/`message`/`docs` where known (schema AgentError); 429s set Retry-After.",
    },
    servers: [{ url: baseUrl }],
    components: {
      securitySchemes: {
        apiKey: { type: "apiKey", in: "header", name: "x-api-key", description: "Optional developer key from POST /v1/keys. Also accepted as Authorization: Bearer <key>." },
      },
      schemas: { MerchantSummary: merchantSummary, BookingStatus: bookingStatus, AgentError: agentError },
    },
    paths: {
      "/v1/meta": {
        get: {
          summary: "Registry metadata: coverage, freshness, schema version, ordering rule",
          description: "Evaluate the registry itself — merchant/bookable counts, verification and freshness stats (including how stale the data is), feedback corpus size, and the documented deterministic ordering rule.",
          responses: { "200": { description: "Registry metadata." } },
        },
      },
      "/v1/stats": {
        get: {
          summary: "Aggregate operational stats (PII-free): booking funnel, completion rate, failure reasons",
          description: "Public health/ops feed: booking counts by state, completion rate, median confirmation time, structured failure reasons, voice-agent containment, feedback corpus size. Contains no reservation, contact, or per-merchant data.",
          responses: { "200": { description: "Aggregate operational stats." } },
        },
      },
      "/healthz": {
        get: {
          summary: "Liveness/readiness probe for uptime monitors",
          responses: { "200": { description: "{ok: true, merchants, schema_version, uptime_s}." }, "503": { description: "{ok: false} — database unavailable." } },
        },
      },
      "/.well-known/mcp.json": {
        get: {
          summary: "Discovery manifest for MCP/agent directories and crawlers",
          description: "Machine-readable service card: MCP endpoint + transport, tool list, REST index, data policy (including honest current-data status), coverage.",
          responses: { "200": { description: "Discovery manifest." } },
        },
      },
      "/v1/merchants": {
        get: {
          summary: "Filter-based merchant search (NOT ranked; deterministic order)",
          description: "Order: merchant_id ASC by default; distance ASC (ties by merchant_id) when lat/lng given with order_by=distance. The registry never ranks (REQ-DATA-2).",
          parameters: [
            { name: "neighborhood", in: "query", schema: { type: "string" } },
            { name: "lat", in: "query", schema: { type: "number" } },
            { name: "lng", in: "query", schema: { type: "number" } },
            { name: "radius_km", in: "query", schema: { type: "number", default: 3 } },
            { name: "cuisine_tags", in: "query", schema: { type: "string" }, description: "Comma-separated; matches ANY." },
            { name: "attribute_tags", in: "query", schema: { type: "string" }, description: "Comma-separated; matches ALL." },
            { name: "price_band_min", in: "query", schema: { type: "integer", minimum: 1, maximum: 4 } },
            { name: "price_band_max", in: "query", schema: { type: "integer", minimum: 1, maximum: 4 } },
            { name: "open_at", in: "query", schema: { type: "string" }, description: "ISO-8601 datetime; only merchants open then. Explicit offset = exact instant (evaluated per merchant timezone); naive = each merchant's local wall clock." },
            { name: "bookable_only", in: "query", schema: { type: "boolean" } },
            { name: "party_size", in: "query", schema: { type: "integer", minimum: 1 } },
            { name: "order_by", in: "query", schema: { type: "string", enum: ["merchant_id", "distance"] } },
            { name: "limit", in: "query", schema: { type: "integer", maximum: config.mcp.searchPageSizeMax } },
            { name: "offset", in: "query", schema: { type: "integer", minimum: 0 } },
          ],
          responses: {
            "400": errorResponse("invalid_open_at — unparseable open_at value."),
            "429": errorResponse("rate_limited — wait Retry-After seconds (also in retry_after_s), then resume."),
            "200": {
              description: "Deterministically ordered page of compact merchant records.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      order: { type: "string", enum: ["merchant_id", "distance"] },
                      total: { type: "integer" },
                      results: { type: "array", items: { $ref: "#/components/schemas/MerchantSummary" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/v1/merchants/{merchant_id}": {
        get: {
          summary: "Full signal dump for one merchant — maximal data, zero opinion",
          description: "Every schema field plus structured hours, raw feedback history, aggregate feedback summary, platform-observed operational stats, and per-field provenance with timestamps.",
          parameters: [{ name: "merchant_id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "Full merchant record." }, "404": errorResponse("unknown_merchant") },
        },
      },
      "/v1/export/merchants.ndjson": {
        get: {
          summary: "Bulk export of the whole registry (NDJSON) — encouraged, not fought",
          description: "Whole-city ingestion for serious agent developers (REQ-MCP-5). Open data is the adoption strategy. Opted-out merchants are excluded.",
          responses: { "200": { description: "One merchant JSON object per line.", content: { "application/x-ndjson": {} } } },
        },
      },
      "/v1/keys": {
        post: {
          summary: "Self-serve developer key (free; abuse control, not gating)",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["developer_name", "contact"],
                  properties: {
                    developer_name: { type: "string", maxLength: 80 },
                    contact: { type: "string", maxLength: 120 },
                    webhook_url: { type: "string", description: "Optional http(s) URL for booking state-change webhooks." },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "New key (reg_...) and documented rate limit." },
            "400": errorResponse("invalid_developer_name | invalid_contact | invalid_webhook_url."),
            "429": errorResponse("key_minting_limit_per_ip | key_minting_limit_global — Retry-After says when the rolling 24h window frees up."),
          },
        },
      },
      "/v1/bookings": {
        post: {
          summary: "Place a reservation (async — a call is placed to the merchant)",
          description: "Returns booking_id with state=queued immediately. Poll GET /v1/bookings/{id} or supply callback_url for webhooks. With accept_within_window=true (recommended), merchant counter-offers inside ±window_minutes auto-confirm without a round-trip. Retry safety: send a unique client_reference_id (or Idempotency-Key header); retrying with the same value returns the existing booking (200, idempotent_replay=true) instead of double-booking.",
          security: [{}, { apiKey: [] }],
          parameters: [
            { name: "Idempotency-Key", in: "header", required: false, schema: { type: "string", maxLength: 128 }, description: "Alias for body field client_reference_id (body wins if both are sent)." },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["merchant_id", "party_size", "datetime", "reservation_name"],
                  properties: {
                    merchant_id: { type: "string", format: "uuid" },
                    party_size: { type: "integer", minimum: 1 },
                    datetime: { type: "string", description: "Requested time, ISO-8601. Naive (2026-07-18T19:00) means the merchant's local wall time; an explicit offset is also accepted." },
                    window_minutes: { type: "integer", minimum: 0, maximum: 240 },
                    accept_within_window: { type: "boolean" },
                    reservation_name: { type: "string" },
                    contact: { type: "string", description: "Optional phone/email for confirmation relay to the end human." },
                    special_requests: { type: "string", maxLength: config.mcp.specialRequestMaxChars },
                    callback_url: { type: "string", description: "Webhook URL for booking state-change events." },
                    client_reference_id: { type: "string", maxLength: 128, description: "Your unique ID for this booking request (a UUID is ideal). Retrying with the same value returns the existing booking instead of creating a duplicate; scoped per API key." },
                  },
                },
              },
            },
          },
          responses: {
            "201": { description: "Accepted: {ok, booking_id, state: queued}." },
            "200": { description: "Idempotent replay: {ok, booking_id, state, idempotent_replay: true} — an existing booking matched client_reference_id; nothing new was created." },
            "400": errorResponse("Structured rejection, e.g. merchant_not_phone_verified, requires_deposit_not_supported_in_v1, party_size_out_of_range (with the merchant's real range in `allowed`)."),
            "401": errorResponse("invalid_api_key | key_throttled_high_no_show_rate (keys are optional; omit rather than guess)."),
            "404": errorResponse("unknown_merchant."),
            "409": errorResponse("client_reference_conflict: this client_reference_id was already used with different request parameters — use a fresh reference for a genuinely new booking."),
            "429": errorResponse("rate_limited — wait Retry-After seconds, then resume."),
          },
        },
      },
      "/v1/bookings/{booking_id}": {
        get: {
          summary: "Booking status: state machine position + structured outcome",
          parameters: [
            { name: "booking_id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
            { name: "include_events", in: "query", schema: { type: "boolean" }, description: "Include the full audit log." },
          ],
          responses: {
            "200": { description: "Booking status.", content: { "application/json": { schema: { $ref: "#/components/schemas/BookingStatus" } } } },
            "404": errorResponse("unknown_booking."),
          },
        },
      },
      "/v1/bookings/{booking_id}/modify": {
        post: {
          summary: "Amend a booking / resolve needs_input",
          description: "In needs_input: pass accept_option_index to take a merchant-offered time (confirms immediately) or amend datetime/party_size to re-queue. Modifying a confirmed booking cancels and rebooks (new booking_id returned).",
          parameters: [{ name: "booking_id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    datetime: { type: "string" },
                    party_size: { type: "integer", minimum: 1 },
                    window_minutes: { type: "integer", minimum: 0, maximum: 240 },
                    accept_option_index: { type: "integer", minimum: 0 },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Updated state." }, "400": errorResponse("invalid_option_index | booking_in_terminal_state."), "404": errorResponse("unknown_booking.") },
        },
      },
      "/v1/bookings/{booking_id}/cancel": {
        post: {
          summary: "Cancel a booking (mandatory when plans change — no-shows are tracked)",
          parameters: [{ name: "booking_id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { reason: { type: "string" } } } } } },
          responses: { "200": { description: "Cancelled." }, "400": errorResponse("booking_in_terminal_state — already failed/cancelled."), "404": errorResponse("unknown_booking.") },
        },
      },
      "/v1/bookings/{booking_id}/feedback": {
        post: {
          summary: "Post-visit feedback (confirmed bookings only, once, within 14 days)",
          description: "Served raw to all agents via the merchant record — never editorialized, never scored (REQ-FBK-3).",
          parameters: [{ name: "booking_id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["reservation_honored"],
                  properties: {
                    reservation_honored: { type: "boolean" },
                    seated_on_time: { type: "boolean" },
                    matched_description: { type: "boolean" },
                    would_repeat: { type: "boolean" },
                    free_text: { type: "string", maxLength: config.feedback.maxFreeTextChars },
                  },
                },
              },
            },
          },
          responses: { "201": { description: "Recorded." }, "400": errorResponse("feedback_requires_confirmed_booking | feedback_window_expired | feedback_already_submitted | free_text_too_long."), "404": errorResponse("unknown_booking.") },
        },
      },
    },
    "x-rate-limits": {
      per_minute: config.mcp.rateLimitPerMinute,
      headers: ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"],
      on_429: "Retry-After header (seconds) + retry_after_s/limit/remaining/reset in the body — wait exactly that long, then resume.",
    },
    "x-mcp": {
      endpoint: "/mcp",
      transport: "streamable-http",
      note: "Agents with MCP support should prefer the MCP endpoint; tools self-describe via tools/list.",
    },
  };
}

/** Compact index served at GET /v1 — the first thing a probing agent sees. */
export function v1Index(baseUrl: string) {
  return {
    service: "Registry — agent-native merchant registry",
    city: config.launchCity,
    schema_version: config.schemaVersion,
    openapi: `${baseUrl}/v1/openapi.json`,
    mcp_endpoint: `${baseUrl}/mcp`,
    docs: "https://github.com/mercantry/registry",
    endpoints: {
      meta: `${baseUrl}/v1/meta`,
      stats: `${baseUrl}/v1/stats`,
      search: `${baseUrl}/v1/merchants`,
      merchant: `${baseUrl}/v1/merchants/{merchant_id}`,
      bulk_export: `${baseUrl}/v1/export/merchants.ndjson`,
      keys: `${baseUrl}/v1/keys`,
      bookings: `${baseUrl}/v1/bookings`,
      health: `${baseUrl}/healthz`,
      discovery_manifest: `${baseUrl}/.well-known/mcp.json`,
      privacy_policy: `${baseUrl}/privacy`,
    },
    posture: "Reads free and unauthenticated. Search is filter-based and never ranked. Availability is checked on the call at booking time.",
  };
}
