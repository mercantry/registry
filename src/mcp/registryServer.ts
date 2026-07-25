/**
 * Registry v1 MCP tool surface (§6.2) — shared by every transport.
 *
 * buildRegistryServer() registers the identical tool set whether the server
 * is reached over stdio (local, `npm run mcp`) or Streamable HTTP (remote
 * agents, mounted at /mcp — see src/mcp/http.ts). One product, N transports.
 *
 * Design rules baked in:
 *  - Filter-based search, never ranked (REQ-DATA-2). Ordering is deterministic and documented.
 *  - get_merchant is a full signal dump: maximal data, zero opinion.
 *  - get_availability is honest: v1 holds no live availability (availability_check: performed_at_booking).
 *  - Booking is async: place_booking returns immediately; poll get_booking_status or use callback_url.
 *
 * Tool descriptions are written for LLM tool selection first (REQ-MCP-6).
 */
import type { Database } from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "../config.js";
import {
  feedbackSummary,
  getMerchant,
  getProvenance,
  operationalStats,
  registryMeta,
  searchMerchants,
} from "../registry/merchants.js";
import {
  bookingStatus,
  cancelBooking,
  getBookingEvents,
  modifyBooking,
  placeBooking,
} from "../orchestrator/bookings.js";
import { feedbackHistory, submitFeedback } from "../feedback/feedback.js";

export interface RegistryServerOptions {
  /** Resolved developer key id — attributed to bookings for abuse control + metrics (never gating). */
  apiKeyId?: string;
}

export function buildRegistryServer(db: Database, opts: RegistryServerOptions = {}): McpServer {
  const server = new McpServer({
    name: "registry",
    version: config.schemaVersion,
  });

  const json = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  });

  server.registerTool(
    "search_merchants",
    {
      title: "Search merchants",
      description:
        `Filter-based search over the restaurant registry (coverage cities + timezones in get_registry_meta). NOT ranked: results come back in deterministic order (merchant_id ASC by default; distance ASC when lat/lng given and order_by="distance"). Returns compact records with pagination. Use get_merchant for the full signal dump on a specific merchant. All filters are optional and combinable.`,
      inputSchema: {
        neighborhood: z.string().optional().describe("Exact neighborhood name, e.g. 'Mission'"),
        lat: z.number().optional().describe("Latitude for geo-radius filter (requires lng and radius_km)"),
        lng: z.number().optional(),
        radius_km: z.number().optional().describe("Radius in km around lat/lng"),
        cuisine_tags: z.array(z.string()).optional().describe("Match ANY of these cuisines, e.g. ['japanese','korean']"),
        attribute_tags: z.array(z.string()).optional().describe("Match ALL of these attributes, e.g. ['outdoor_seating','vegetarian_friendly']"),
        price_band_min: z.number().int().min(1).max(4).optional(),
        price_band_max: z.number().int().min(1).max(4).optional(),
        open_at: z.string().optional().describe("ISO-8601 datetime; only merchants open at this time. With an explicit offset ('2026-07-18T19:00:00+09:00' or trailing Z) the instant is evaluated in each merchant's own timezone; without one it means each merchant's local wall clock"),
        bookable_only: z.boolean().optional().describe("Only merchants the registry can book right now (phone-verified, accepts reservations, not opted out)"),
        party_size: z.number().int().min(1).optional().describe("Only merchants that can seat this party size"),
        order_by: z.enum(["merchant_id", "distance"]).optional(),
        limit: z.number().int().min(1).max(config.mcp.searchPageSizeMax).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async (args) => {
      const near =
        args.lat !== undefined && args.lng !== undefined
          ? { lat: args.lat, lng: args.lng, radius_km: args.radius_km ?? 3 }
          : undefined;
      try {
        return json(
          searchMerchants(db, {
            neighborhood: args.neighborhood,
            near,
            cuisine_tags: args.cuisine_tags,
            attribute_tags: args.attribute_tags,
            price_band_min: args.price_band_min,
            price_band_max: args.price_band_max,
            open_at: args.open_at,
            bookable_only: args.bookable_only,
            party_size: args.party_size,
            order_by: args.order_by,
            limit: args.limit,
            offset: args.offset,
          }),
        );
      } catch (e) {
        if (e instanceof Error && e.message === "invalid_open_at") return json({ error: "invalid_open_at" });
        throw e;
      }
    },
  );

  server.registerTool(
    "get_merchant",
    {
      title: "Get merchant (full signal dump)",
      description:
        "Every field the registry holds on one merchant: schema fields, structured hours, raw feedback history, platform-observed operational stats, and per-field provenance with timestamps. Maximal data, zero opinion — the registry never scores or ranks.",
      inputSchema: { merchant_id: z.string() },
    },
    async ({ merchant_id }) => {
      const m = getMerchant(db, merchant_id);
      if (!m) return json({ error: "unknown_merchant" });
      return json({
        ...m,
        feedback_summary: feedbackSummary(db, merchant_id),
        feedback_history: feedbackHistory(db, merchant_id),
        operational_stats: operationalStats(db, merchant_id),
        source_provenance: getProvenance(db, merchant_id),
      });
    },
  );

  server.registerTool(
    "get_availability",
    {
      title: "Get availability (honest v1 behavior)",
      description:
        "V1 does NOT hold live table availability — availability is checked on the phone call at booking time. This tool returns the merchant's reservation policy, structured hours, and holiday exceptions so you can pick a plausible time before calling place_booking.",
      inputSchema: { merchant_id: z.string() },
    },
    async ({ merchant_id }) => {
      const m = getMerchant(db, merchant_id);
      if (!m) return json({ error: "unknown_merchant" });
      return json({
        merchant_id,
        availability_check: "performed_at_booking",
        reservation_policy: m.reservation_policy,
        bookable: m.bookable,
        hours: m.hours,
        holiday_exceptions: m.holiday_exceptions,
        max_party_size: m.max_party_size,
        note: "The registry places a call to confirm availability when you book. Provide window_minutes and accept_within_window on place_booking to resolve counter-offers without a round-trip.",
      });
    },
  );

  server.registerTool(
    "place_booking",
    {
      title: "Place a booking (async)",
      description:
        "Request a table reservation. Returns booking_id with state 'queued' immediately; fulfillment is asynchronous (a call is placed to the merchant). Poll get_booking_status or supply callback_url for webhooks. RETRY SAFETY: pass a unique client_reference_id (recommended: always); if this call times out or errors ambiguously, retry with the SAME client_reference_id and the registry returns the already-created booking instead of double-booking the restaurant. Never re-call place_booking after a timeout without one. If the merchant counter-offers a time within window_minutes and accept_within_window=true, it is auto-accepted (recommended). Otherwise the booking pauses in needs_input for you to resolve via modify_booking. Merchants on the human_call channel are fulfilled by a human operator during the operator window published in get_registry_meta — those bookings queue until worked (up to the channel SLA), so book ahead rather than for the next hour.",
      inputSchema: {
        merchant_id: z.string(),
        party_size: z.number().int().min(1),
        datetime: z.string().describe("Requested time, ISO-8601. Naive ('2026-07-18T19:00') means the merchant's LOCAL wall time (see the merchant's timezone field); an explicit offset ('2026-07-18T19:00:00+09:00') is also accepted"),
        window_minutes: z.number().int().min(0).max(240).optional().describe("Acceptable +/- window around datetime"),
        accept_within_window: z.boolean().optional().describe("Auto-accept merchant counter-offers inside the window (recommended: true)"),
        reservation_name: z.string().describe("Name for the reservation"),
        contact: z.string().optional().describe("Optional phone/email for confirmation relay to the end human"),
        special_requests: z.string().max(config.mcp.specialRequestMaxChars).optional(),
        callback_url: z.string().url().optional().describe("Webhook URL for booking state-change events"),
        client_reference_id: z.string().min(1).max(128).optional().describe("Your unique ID for this booking request (a UUID is ideal). Retrying with the same value returns the existing booking (idempotent_replay: true) instead of creating a duplicate; the same value with different parameters is rejected as client_reference_conflict"),
      },
    },
    async (args) =>
      json(
        placeBooking(db, {
          merchant_id: args.merchant_id,
          party_size: args.party_size,
          datetime: args.datetime,
          window_minutes: args.window_minutes,
          accept_within_window: args.accept_within_window,
          reservation_name: args.reservation_name,
          contact: args.contact,
          special_requests: args.special_requests,
          callback_url: args.callback_url,
          client_reference_id: args.client_reference_id,
          api_key_id: opts.apiKeyId,
        }),
      ),
  );

  server.registerTool(
    "get_booking_status",
    {
      title: "Get booking status",
      description:
        "State machine position for a booking: pending → queued → in_progress → confirmed | failed | needs_input (plus cancelled). Includes structured details on confirmation (confirmed_time, confirmation_code, merchant_instructions), structured failure reason (no_answer | fully_booked | closed | policy_mismatch | merchant_declined | bad_data), or needs_input options awaiting your decision. include_events=true returns the full audit log.",
      inputSchema: {
        booking_id: z.string(),
        include_events: z.boolean().optional(),
      },
    },
    async ({ booking_id, include_events }) => {
      const status = bookingStatus(db, booking_id);
      if (!status) return json({ error: "unknown_booking" });
      return json(include_events ? { ...status, events: getBookingEvents(db, booking_id) } : status);
    },
  );

  server.registerTool(
    "modify_booking",
    {
      title: "Modify a booking / resolve needs_input",
      description:
        "Amend a booking before or after the call. For a booking in needs_input: pass accept_option_index to take one of the merchant's offered times (confirms immediately), or pass a new datetime/party_size to re-queue an amended request. Modifying an already-confirmed booking cancels it and books the new request (new booking_id returned).",
      inputSchema: {
        booking_id: z.string(),
        datetime: z.string().optional().describe("New requested time, ISO-8601; naive means the merchant's local wall time"),
        party_size: z.number().int().min(1).optional(),
        window_minutes: z.number().int().min(0).max(240).optional(),
        accept_option_index: z.number().int().min(0).optional().describe("Index into needs_input_options to accept"),
      },
    },
    async ({ booking_id, ...changes }) => json(modifyBooking(db, booking_id, changes)),
  );

  server.registerTool(
    "cancel_booking",
    {
      title: "Cancel a booking",
      description:
        "Cancel a booking in any non-terminal state, or a confirmed reservation (the registry notifies the merchant). Cancellation is mandatory when the human no longer wants the table — no-shows destroy merchant trust and are tracked per developer key.",
      inputSchema: {
        booking_id: z.string(),
        reason: z.string().optional(),
      },
    },
    async ({ booking_id, reason }) => json(cancelBooking(db, booking_id, reason)),
  );

  server.registerTool(
    "submit_feedback",
    {
      title: "Submit post-visit feedback",
      description:
        "Report how a confirmed reservation actually went. Accepted only against a confirmed booking_id, once per booking, within 14 days of confirmation. Structured fields first; optional free text ≤ 500 chars. This corpus is served raw to all agents via get_merchant — it is never editorialized or turned into a score.",
      inputSchema: {
        booking_id: z.string(),
        reservation_honored: z.boolean().describe("Did the merchant honor the reservation?"),
        seated_on_time: z.boolean().optional(),
        matched_description: z.boolean().optional().describe("Did the merchant match the registry's description?"),
        would_repeat: z.boolean().optional(),
        free_text: z.string().max(config.feedback.maxFreeTextChars).optional(),
      },
    },
    async (args) => json(submitFeedback(db, args)),
  );

  server.registerTool(
    "get_registry_meta",
    {
      title: "Get registry metadata",
      description:
        "Evaluate the registry itself: per-city coverage (with each city's IANA timezone), merchant/bookable counts, verification and freshness stats, feedback corpus size, schema version, and the documented deterministic ordering rule. Honest by design — including how stale the data is.",
      inputSchema: {},
    },
    async () => json(registryMeta(db)),
  );

  return server;
}
