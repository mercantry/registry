/**
 * Agent-actionable error contract, shared by REST and MCP.
 *
 * Agents self-correct from error payloads alone, so every 4xx/5xx carries:
 *  - `error`: a stable machine code (never interpolated — safe to match exactly)
 *  - `message`: what went wrong and what to do instead
 *  - `field` / `allowed` / `example`: the offending input and how to fix it, where known
 *  - `docs`: URL of the machine-readable contract (OpenAPI)
 *
 * The catalog is the single source of truth: REST maps codes to HTTP statuses
 * with statusFor(); MCP returns the same object as tool output. Call sites may
 * override catalog defaults with request-specific detail (e.g. the actual
 * allowed party-size range for the merchant being booked).
 */
import { config } from "../config.js";
import { SANDBOX_OUTCOMES } from "./types.js";

export interface AgentErrorDetail {
  message?: string;
  field?: string;
  allowed?: string;
  example?: string;
}

export interface AgentError extends AgentErrorDetail {
  ok: false;
  error: string;
}

interface CatalogEntry extends AgentErrorDetail {
  status: number;
}

export const DOCS_PATH = "/v1/openapi.json";

/** Absolute docs URL when a base is known; the bare path otherwise (stdio MCP with no configured base). */
export function docsUrl(base?: string): string {
  const b = base ?? config.publicBaseUrl;
  return b ? `${b.replace(/\/$/, "")}${DOCS_PATH}` : DOCS_PATH;
}

export const ERROR_CATALOG: Record<string, CatalogEntry> = {
  /* Lookups */
  unknown_merchant: {
    status: 404,
    field: "merchant_id",
    message: "No merchant with this id exists in the registry. Find merchant ids via search_merchants (GET /v1/merchants).",
  },
  unknown_booking: {
    status: 404,
    field: "booking_id",
    message: "No booking with this id. Booking ids are returned by place_booking (POST /v1/bookings).",
  },
  unknown_endpoint: {
    status: 404,
    message: "No such /v1 endpoint. GET /v1 lists every endpoint; the OpenAPI document is the full contract.",
  },

  /* Booking guards (place_booking) */
  fulfillment_not_live: {
    status: 400,
    field: "merchant_id",
    message: "This merchant is served for discovery only — real-merchant fulfillment is not live yet. Sandbox merchants (sandbox: true) accept end-to-end test bookings.",
  },
  merchant_opted_out: {
    status: 400,
    field: "merchant_id",
    message: "This merchant has opted out of registry fulfillment and cannot be booked.",
  },
  requires_deposit_not_supported_in_v1: {
    status: 400,
    field: "merchant_id",
    message: "This merchant requires a deposit to reserve; v1 cannot place deposits. Pick a merchant with bookable: true.",
  },
  merchant_not_phone_verified: {
    status: 400,
    field: "merchant_id",
    message: "This merchant's phone is not yet verified, so the registry will not call it. Filter with bookable_only: true to find bookable merchants.",
  },
  reservation_policy_not_bookable: {
    status: 400,
    field: "merchant_id",
    message: "This merchant's reservation policy does not accept phone reservations (e.g. walk_in_only). Filter with bookable_only: true.",
  },
  party_size_out_of_range: {
    status: 400,
    field: "party_size",
    message: "party_size is outside what this merchant can seat. The merchant record's max_party_size field has the ceiling.",
  },
  special_requests_too_long: {
    status: 400,
    field: "special_requests",
    allowed: `1-${config.mcp.specialRequestMaxChars} chars`,
    message: `special_requests is capped at ${config.mcp.specialRequestMaxChars} characters — shorten it and retry.`,
  },
  invalid_datetime: {
    status: 400,
    field: "datetime",
    example: "2026-07-18T19:00 (merchant-local) or 2026-07-18T19:00:00+09:00 (explicit offset)",
    message: "datetime is not a parseable ISO-8601 value. Naive datetimes mean the merchant's local wall time; an explicit offset pins the instant.",
  },
  invalid_client_reference_id: {
    status: 400,
    field: "client_reference_id",
    message: "client_reference_id must be a non-empty string within the length cap (a UUID is ideal).",
  },
  client_reference_conflict: {
    status: 409,
    field: "client_reference_id",
    message: "This client_reference_id was already used with different request parameters. A reference names one exact request: retry with identical parameters to replay it, or use a fresh reference for a new booking.",
  },
  invalid_sandbox_outcome: {
    status: 400,
    field: "sandbox_outcome",
    allowed: SANDBOX_OUTCOMES.join(" | "),
    example: "confirmed",
    message: "sandbox_outcome must be one of the documented test outcomes. Omit it to get the default pseudo-random outcome.",
  },
  sandbox_outcome_requires_sandbox_merchant: {
    status: 400,
    field: "sandbox_outcome",
    message: "sandbox_outcome forces the result of a simulated call and is accepted only for sandbox merchants (sandbox: true). A real merchant's outcome comes from the real call — omit the field.",
  },

  /* modify_booking / cancel_booking */
  invalid_option_index: {
    status: 400,
    field: "accept_option_index",
    message: "accept_option_index does not match any entry in needs_input_options. Re-read get_booking_status and pass a valid zero-based index.",
  },
  booking_in_terminal_state: {
    status: 400,
    field: "booking_id",
    message: "This booking is already in a terminal state and cannot be changed. Place a new booking instead.",
  },

  /* Feedback */
  feedback_requires_confirmed_booking: {
    status: 400,
    field: "booking_id",
    message: "Feedback is accepted only against a booking in state 'confirmed'.",
  },
  feedback_window_expired: {
    status: 400,
    field: "booking_id",
    allowed: `within ${config.feedback.windowDays} days of confirmation`,
    message: `Feedback closes ${config.feedback.windowDays} days after confirmation; this booking's window has passed.`,
  },
  feedback_already_submitted: {
    status: 400,
    field: "booking_id",
    message: "Feedback was already submitted for this booking — one submission per booking.",
  },
  free_text_too_long: {
    status: 400,
    field: "free_text",
    allowed: `1-${config.feedback.maxFreeTextChars} chars`,
    message: `free_text is capped at ${config.feedback.maxFreeTextChars} characters — shorten it and retry.`,
  },

  /* Search */
  invalid_open_at: {
    status: 400,
    field: "open_at",
    example: "2026-07-18T19:00 (merchant-local) or 2026-07-18T19:00:00+09:00 (explicit offset)",
    message: "open_at is not a parseable ISO-8601 value. Naive datetimes mean each merchant's local wall clock; an explicit offset pins the instant.",
  },

  /* API keys */
  invalid_api_key: {
    status: 401,
    message: "The presented API key is not recognized. Keys are OPTIONAL (v1 is free) — omit the key entirely rather than guessing, or mint one via POST /v1/keys.",
  },
  key_throttled_high_no_show_rate: {
    status: 401,
    message: "This key is throttled for a high no-show rate. Cancel bookings when plans change; contact the registry to restore access.",
  },
  invalid_developer_name: {
    status: 400,
    field: "developer_name",
    allowed: "1-80 chars",
    message: "developer_name is required: a non-empty string up to 80 characters.",
  },
  invalid_contact: {
    status: 400,
    field: "contact",
    allowed: "1-120 chars",
    message: "contact is required: a non-empty string up to 120 characters (email or URL where the registry can reach you).",
  },
  invalid_webhook_url: {
    status: 400,
    field: "webhook_url",
    allowed: "http(s) URL, max 300 chars",
    example: "https://example.com/hooks/registry",
    message: "webhook_url must be an absolute http(s) URL of at most 300 characters.",
  },
  key_minting_limit_per_ip: {
    status: 429,
    message: `Self-serve keys are limited to ${config.mcp.keysPerIpPerDay} per client per rolling 24h. Reuse a key you already minted (one key works for all your agents), wait for Retry-After, or contact the registry to raise your limit.`,
  },
  key_minting_limit_global: {
    status: 429,
    message: "The registry-wide daily key-minting cap is reached. Retry after the window rolls over, or contact the registry.",
  },

  /* Transport */
  rate_limited: {
    status: 429,
    message: `Rate limit is ${config.mcp.rateLimitPerMinute} requests/minute per key (or per IP without a key). Wait Retry-After seconds, then resume; X-RateLimit-* headers carry live state on every response.`,
  },
  invalid_json_body: {
    status: 400,
    message: "The request body is not valid JSON. Send a JSON object with content-type: application/json.",
  },
  payload_too_large: {
    status: 413,
    message: "The request body exceeds the size limit.",
  },
  internal_error: {
    status: 500,
    message: "Unexpected server error — not a problem with your request. Safe to retry; persistent failures are worth reporting.",
  },
};

/**
 * Build a structured error result. Catalog defaults fill message/field/
 * allowed/example; call-site overrides win (e.g. the booked merchant's real
 * party-size range). Unknown codes pass through with no decoration.
 */
export function agentError(code: string, overrides: AgentErrorDetail = {}): AgentError {
  const entry = ERROR_CATALOG[code];
  return {
    ok: false,
    error: code,
    ...(entry
      ? {
          ...(entry.message !== undefined && { message: entry.message }),
          ...(entry.field !== undefined && { field: entry.field }),
          ...(entry.allowed !== undefined && { allowed: entry.allowed }),
          ...(entry.example !== undefined && { example: entry.example }),
        }
      : {}),
    ...overrides,
  };
}

/** HTTP status for a code (REST layer). Unknown codes are client errors. */
export function statusFor(code: string | undefined): number {
  return (code && ERROR_CATALOG[code]?.status) || 400;
}
