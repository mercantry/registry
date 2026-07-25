/**
 * Public discovery surface (note 001: presence + credibility; REQ-DST-1/2).
 *
 *  - GET /.well-known/mcp.json  machine-readable manifest for MCP/agent
 *    directories and crawlers: where the endpoint is, what tools exist,
 *    what the data policy is. Honest by design — coverage and data status
 *    are derived from the live database, never hardcoded copy.
 *  - GET /.well-known/agent-card.json  AgentCard-shaped discovery document
 *    (A2A card schema) for agent directories that crawl this path. Honest
 *    about transport: this service speaks MCP + REST, NOT the A2A JSON-RPC
 *    protocol — the card says so instead of pretending, and every A2A
 *    protocol capability is declared false.
 *  - GET /llms.txt              the llms.txt template (repo root) rendered
 *    with live stats. Never 500s: serves the last-good render on error.
 *  - GET /robots.txt            AI crawlers explicitly welcome — the corpus
 *    exists to be ingested (GEO playbook).
 *  - GET /healthz               cheap liveness+readiness for uptime monitors
 *    ("don't die" is a strategy metric, so it needs a probe).
 *
 * All unauthenticated on purpose: they exist to be crawled.
 */
import type { Database } from "better-sqlite3";
import express from "express";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

const here = dirname(fileURLToPath(import.meta.url));
/** Marketing owns the copy; this file is the render template ({{...}} markers). */
const LLMS_TEMPLATE_PATH = join(here, "..", "..", "llms.txt");
const REPO_URL = "https://github.com/mercantry/registry";
const LLMS_CACHE_TTL_MS = 60_000;

const fmt = (n: number) => n.toLocaleString("en-US");

/**
 * Per-city counts of the merchants actually served (real, not opted out).
 * Derived from the live DB so public copy can never claim a city we don't
 * serve — e.g. Shanghai stays absent until its release is actually imported
 * (marketing guardrail 07-23).
 */
function cityCoverage(db: Database): { city: string; merchant_count: number }[] {
  return (
    db
      .prepare("SELECT city, COUNT(*) c FROM merchants WHERE sandbox = 0 AND opt_out = 0 GROUP BY city ORDER BY city")
      .all() as { city: string; c: number }[]
  ).map((r) => ({ city: r.city, merchant_count: r.c }));
}

function renderLlmsTxt(db: Database): string {
  const template = readFileSync(LLMS_TEMPLATE_PATH, "utf8");
  const cities = cityCoverage(db);
  const realCount = cities.reduce((s, r) => s + r.merchant_count, 0);
  const citiesLine = cities.length
    ? `${cities.length} cities (${cities.map((r) => `${r.city} ${fmt(r.merchant_count)}`).join(" · ")})`
    : "0 cities (sandbox-only preview — no real corpus imported)";
  return (
    template
      .replace(/<!--\s*Template note[\s\S]*?-->\n?/g, "")
      .replaceAll("{{merchant_count}}", fmt(realCount))
      .replaceAll("{{cities}}", citiesLine)
      // Relative doc links point at repo files; make them resolvable off-host.
      .replace(/\]\((?!https?:)([^)]+)\)/g, (_m, path) => `](${REPO_URL}/blob/main/${path})`)
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() +
    `\n\n---\nGenerated: ${new Date().toISOString()} · schema_version ${config.schemaVersion} · live numbers: get_registry_meta (MCP) or GET /v1/meta\n`
  );
}

/** Fail-safe body if the template was never renderable (canonical sentence, NAMING.md). */
const LLMS_FALLBACK =
  "# Mercantry\n\n> Mercantry is an open commerce registry for AI agents — structured merchant data, honest signals, and real-world booking fulfillment.\n\nLive stats: get_registry_meta (MCP) or GET /v1/meta\n";

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
    const cities = cityCoverage(db);
    res.json({
      name: "registry",
      display_name: "Agentic Commerce Registry",
      description:
        "Agent-native merchant registry with universal fulfillment. V1: restaurant discovery and reservations. " +
        "Filter-based search (never ranked), full-provenance merchant records, transaction-verified feedback only, async booking fulfillment.",
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
      llms_txt: `${base}/llms.txt`,
      agent_card: `${base}/.well-known/agent-card.json`,
      privacy_policy: `${base}/privacy`,
      data_policy: {
        ranking: "none — deterministic, documented ordering only",
        reviews: "transaction-verified agent feedback only; never scraped, never scored",
        freshness_target_days: config.registry.freshnessDays,
        merchant_opt_out: "immediate and permanent",
        privacy_policy: `${base}/privacy`,
        current_data_status:
          meta.real_count > 0
            ? `real merchant corpus live: ${fmt(meta.real_count)} merchants (discovery-only — real merchants are not bookable until fulfillment channels launch) + ${fmt(meta.sandbox_count)} sandbox test merchants`
            : meta.merchant_count > 0
              ? "synthetic/sandbox seed data only (dev preview); no real corpus imported"
              : "empty",
      },
      coverage: {
        cities,
        merchant_count: meta.merchant_count,
        real_count: meta.real_count,
        sandbox_count: meta.sandbox_count,
        bookable_count: meta.bookable_count,
      },
      source: REPO_URL,
      health: `${base}/healthz`,
    });
  });

  // AgentCard (A2A card schema, protocol version 0.3.0) at the well-known
  // path agent directories crawl. The A2A transport enum is open, so the
  // card declares the transports that actually exist ("MCP", "REST") rather
  // than claiming JSONRPC support this service does not have; an A2A-only
  // client will skip us cleanly instead of failing confusingly. Coverage and
  // liveness lines derive from the live DB/config — same honesty rules as
  // every other discovery surface (a city never appears until it is served,
  // and the booking skill says fulfillment is not live while it isn't).
  router.get("/.well-known/agent-card.json", (req, res) => {
    const base = baseUrl(req);
    const meta = registryMeta(db);
    const cities = cityCoverage(db);
    const realCount = cities.reduce((s, r) => s + r.merchant_count, 0);
    const humanCallLive = config.fulfillment.liveChannels.includes("human_call");
    const win = config.fulfillment.operatorWindow;

    const coverageLine = realCount
      ? `Current coverage: ${fmt(realCount)} real merchants across ${cities.map((r) => `${r.city} (${fmt(r.merchant_count)})`).join(", ")}, plus ${fmt(meta.sandbox_count)} sandbox test merchants.`
      : `Current coverage: sandbox-only preview (${fmt(meta.sandbox_count)} deterministic test merchants) — no real corpus imported yet.`;
    const bookingLiveness = humanCallLive
      ? `Real-merchant fulfillment is human-operated (${win.start}-${win.end} ${win.timezone}); bookings queue honestly and auto-fail at the published channel SLA rather than pretending to be instant.`
      : "Real-merchant fulfillment is NOT live yet: place_booking on a real merchant returns the structured rejection 'fulfillment_not_live'. The full booking loop is testable end-to-end against sandbox merchants (deterministic outcomes, never a real phone call).";

    res.json({
      protocolVersion: "0.3.0",
      name: "Mercantry",
      description:
        "Mercantry is an open commerce registry for AI agents — structured merchant data, honest signals, and real-world booking fulfillment. " +
        "Interoperability, honestly: this service speaks MCP (streamable-http) and REST/OpenAPI — it does NOT implement the A2A JSON-RPC protocol. " +
        "This card is published for discovery; connect via the MCP endpoint in `url` or the REST interface in `additionalInterfaces`.",
      url: `${base}/mcp`,
      preferredTransport: "MCP",
      additionalInterfaces: [
        { url: `${base}/mcp`, transport: "MCP" },
        { url: `${base}/v1`, transport: "REST" },
      ],
      provider: { organization: "Mercantry", url: base },
      version: config.schemaVersion,
      documentationUrl: REPO_URL,
      // A2A protocol capabilities — none are implemented, so none are claimed.
      // (Booking webhooks DO exist, but via place_booking's callback_url, not
      // the A2A push-notification protocol these flags refer to.)
      capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
      securitySchemes: {},
      security: [],
      defaultInputModes: ["application/json"],
      defaultOutputModes: ["application/json"],
      skills: [
        {
          id: "merchant_discovery",
          name: "Merchant discovery",
          description:
            "Filter-based search over the restaurant registry (search_merchants), full per-merchant signal dumps with per-field provenance and raw transaction-verified feedback (get_merchant), and honest registry self-description including staleness (get_registry_meta). Never ranked: deterministic, documented ordering only. Reads are free and keyless. " +
            coverageLine,
          tags: ["search", "restaurants", "merchant-data", "provenance", "no-ranking", "open-data"],
          examples: [
            "Find vegetarian-friendly restaurants near Shinjuku that are open Friday 7pm",
            "Get every signal the registry holds on merchant X, including feedback history",
          ],
        },
        {
          id: "booking",
          name: "Reservation booking (async)",
          description:
            "Async table reservations: get_availability (honest v1 — availability is confirmed at booking time, not held live), place_booking, get_booking_status (poll or callback_url webhooks), modify_booking, cancel_booking. Bookings are accepted only for phone-verified bookable merchants. " +
            bookingLiveness,
          tags: ["booking", "reservations", "async", "sandbox"],
          examples: [
            "Book a table for 4 at a sandbox merchant tomorrow 19:00 and poll until confirmed",
            "Cancel a booking the human no longer wants",
          ],
        },
        {
          id: "verified_feedback",
          name: "Transaction-verified feedback",
          description:
            "submit_feedback: report how a confirmed reservation actually went — accepted only against a confirmed booking_id, once per booking, within 14 days. Served raw to all agents via get_merchant; never editorialized, never scored.",
          tags: ["feedback", "verified", "trust"],
          examples: ["Report that the merchant honored the reservation but seated the party late"],
        },
      ],
      supportsAuthenticatedExtendedCard: false,
    });
  });

  // Live-rendered llms.txt with a never-500 guarantee: cache the last good
  // render (60s TTL) and serve it if a fresh render fails for any reason.
  let llmsCache: { body: string; at: number } | undefined;
  router.get("/llms.txt", (_req, res) => {
    const nowMs = Date.now();
    if (!llmsCache || nowMs - llmsCache.at > LLMS_CACHE_TTL_MS) {
      try {
        llmsCache = { body: renderLlmsTxt(db), at: nowMs };
      } catch (e) {
        console.error("llms.txt render failed; serving fallback:", e);
        llmsCache = { body: llmsCache?.body ?? LLMS_FALLBACK, at: nowMs };
      }
    }
    res.type("text/plain; charset=utf-8").send(llmsCache.body);
  });

  router.get("/robots.txt", (req, res) => {
    const base = baseUrl(req);
    res.type("text/plain; charset=utf-8").send(
      `# Mercantry — open commerce registry for AI agents. AI crawlers are welcome:
# the data is openly licensed and exists to be ingested, cached, and trained on.
# Machine-readable surfaces: ${base}/llms.txt · ${base}/.well-known/mcp.json · ${base}/.well-known/agent-card.json · ${base}/v1/openapi.json
# Privacy policy: ${base}/privacy

User-agent: GPTBot
User-agent: ClaudeBot
User-agent: PerplexityBot
User-agent: CCBot
User-agent: Googlebot
User-agent: Bingbot
User-agent: *
Allow: /
Disallow: /ops/
Disallow: /status/
`,
    );
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
