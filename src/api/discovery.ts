/**
 * Public discovery surface (note 001: presence + credibility; REQ-DST-1/2).
 *
 *  - GET /.well-known/mcp.json  machine-readable manifest for MCP/agent
 *    directories and crawlers: where the endpoint is, what tools exist,
 *    what the data policy is. Honest by design — it states plainly that
 *    v1 data is synthetic until real ingestion lands.
 *  - GET /healthz               cheap liveness+readiness for uptime monitors
 *    ("don't die" is a strategy metric, so it needs a probe).
 *
 * Both are unauthenticated on purpose: they exist to be crawled.
 */
import type { Database } from "better-sqlite3";
import express from "express";
import { config } from "../config.js";
import { registryMeta } from "../registry/merchants.js";

const TOOL_NAMES = [
  "search_merchants",
  "get_merchant",
  "get_availability",
  "place_booking",
  "get_booking_status",
  "modify_booking",
  "cancel_booking",
  "submit_feedback",
  "get_registry_meta",
] as const;

/** Base URL for absolute links: PUBLIC_BASE_URL env wins, else derived per-request. */
function baseUrl(req: express.Request): string {
  if (config.publicBaseUrl) return config.publicBaseUrl.replace(/\/$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

export function discoveryRouter(db: Database): express.Router {
  const router = express.Router();

  router.get("/.well-known/mcp.json", (req, res) => {
    const base = baseUrl(req);
    const meta = registryMeta(db);
    res.json({
      name: "registry",
      display_name: "Agentic Commerce Registry",
      description:
        `Agent-native merchant registry with universal fulfillment. V1: restaurant reservations, ${config.launchCity}. ` +
        "Filter-based search (never ranked), full-provenance merchant records, transaction-verified feedback only, async booking via phone-call fulfillment.",
      schema_version: config.schemaVersion,
      mcp: {
        transport: "streamable-http",
        endpoint: `${base}/mcp`,
        stateless: true,
        authentication: {
          type: "none",
          note: "Free in v1. Optional developer key (POST /v1/keys) sent as 'Authorization: Bearer' or 'x-api-key' attributes bookings for abuse control; it never gates reads.",
        },
        tools: TOOL_NAMES,
      },
      rest: {
        base: `${base}/v1`,
        self_serve_keys: `${base}/v1/keys`,
        bulk_export: `${base}/v1/export/merchants.ndjson`,
        meta: `${base}/v1/meta`,
        rate_limit_per_minute: config.mcp.rateLimitPerMinute,
      },
      data_policy: {
        ranking: "none — deterministic, documented ordering only",
        reviews: "transaction-verified agent feedback only; never scraped, never scored",
        freshness_target_days: config.registry.freshnessDays,
        merchant_opt_out: "immediate and permanent",
        current_data_status: meta.merchant_count > 0 ? "synthetic seed data (v1 pre-launch); real ingestion pending" : "empty",
      },
      coverage: {
        city: config.launchCity,
        merchant_count: meta.merchant_count,
        bookable_count: meta.bookable_count,
      },
      source: "https://github.com/mercantry/registry",
      health: `${base}/healthz`,
    });
  });

  router.get("/healthz", (_req, res) => {
    try {
      const c = (db.prepare("SELECT COUNT(*) c FROM merchants").get() as { c: number }).c;
      res.json({ ok: true, merchants: c, schema_version: config.schemaVersion, uptime_s: Math.round(process.uptime()) });
    } catch (e) {
      res.status(503).json({ ok: false, error: String(e) });
    }
  });

  return router;
}
