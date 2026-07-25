/**
 * Registry v1 HTTP server.
 *
 *  - /mcp         agent-facing MCP endpoint over Streamable HTTP (the product,
 *                 reachable by remote agents — src/mcp/http.ts)
 *  - /v1/*        agent-facing REST mirror of the MCP tools (self-serve keys,
 *                 bulk export, rate-limit headers — REQ-MCP-4/5, REQ-DST-2)
 *  - /ops/api/*   internal Ops Console API (§6.5) — gated by OPS_TOKEN when set
 *  - /status/:id  minimal booking status page for end humans (§3)
 *  - /            public landing page (crawlable fact page, live stats)
 *  - /ops/        Ops Console SPA — gated by OPS_TOKEN when set
 *
 * The fulfillment worker runs in this process. Start: npm run dev
 * Internet exposure: docs/deployment.md
 */
import express from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, now } from "../db/index.js";
import { config } from "../config.js";
import {
  feedbackSummary,
  getMerchant,
  getProvenance,
  operationalStats,
  recordAnnoyance,
  recordVerification,
  registryMeta,
  rowToMerchant,
  searchMerchants,
  setOptOut,
  updateMerchantField,
  verificationQueue,
} from "../registry/merchants.js";
import { seedMerchants } from "../registry/seed.js";
import {
  bookingStatus,
  cancelBooking,
  getBooking,
  getBookingEvents,
  modifyBooking,
  placeBooking,
} from "../orchestrator/bookings.js";
import { finishAttempt, startWorker } from "../orchestrator/worker.js";
import { transition, logEvent } from "../orchestrator/stateMachine.js";
import { appendTranscript } from "../orchestrator/voiceSim.js";
import { feedbackHistory, submitFeedback } from "../feedback/feedback.js";
import { mcpRouter } from "../mcp/http.js";
import { discoveryRouter } from "./discovery.js";
import { landingRouter } from "./landing.js";
import { publicStats } from "./stats.js";
import { keyFromHeaders, keysRouter, resolveApiKey } from "./keys.js";
import { buildOpenApi, v1Index } from "./openapi.js";

type Row = Record<string, any>;

const here = dirname(fileURLToPath(import.meta.url));
const db = getDb();

// Convenience: auto-seed on first boot so `npm run dev` works out of the box.
if ((db.prepare("SELECT COUNT(*) c FROM merchants").get() as Row).c === 0) {
  console.log("Empty registry — seeding 500 merchants...");
  seedMerchants(db, 500);
}

const app = express();
app.use(express.json());

// Behind a load balancer / tunnel, trust X-Forwarded-For so per-IP rate limiting works.
if (config.trustProxy) {
  app.set("trust proxy", config.trustProxy === "true" ? true : Number.isNaN(Number(config.trustProxy)) ? config.trustProxy : Number(config.trustProxy));
}

/* ------------------------------------------------------------------ */
/* Rate limiting (REQ-MCP-5): documented limits, returned in headers.  */
/* Applies to both agent surfaces: REST (/v1) and MCP over HTTP (/mcp).*/
/* Gate B hardening: buckets key on VALID api keys or the client IP —  */
/* never on unvalidated header values, or rotating junk keys would     */
/* bypass per-IP limits and grow memory without bound.                  */
/* ------------------------------------------------------------------ */
const buckets = new Map<string, { count: number; resetAt: number }>();
const pruneBuckets = setInterval(() => {
  const nowMs = Date.now();
  for (const [id, b] of buckets) if (b.resetAt <= nowMs) buckets.delete(id);
}, 60_000);
pruneBuckets.unref?.();
const rateLimit: express.RequestHandler = (req, res, next) => {
  const presented = keyFromHeaders(req.headers);
  const validKey = presented && !resolveApiKey(db, presented).error ? presented : undefined;
  const id = (validKey ?? req.ip ?? "anon") as string;
  const nowMs = Date.now();
  let b = buckets.get(id);
  if (!b || b.resetAt <= nowMs) {
    b = { count: 0, resetAt: nowMs + 60_000 };
    buckets.set(id, b);
  }
  b.count++;
  res.setHeader("X-RateLimit-Limit", String(config.mcp.rateLimitPerMinute));
  res.setHeader("X-RateLimit-Remaining", String(Math.max(0, config.mcp.rateLimitPerMinute - b.count)));
  res.setHeader("X-RateLimit-Reset", String(Math.ceil(b.resetAt / 1000)));
  if (b.count > config.mcp.rateLimitPerMinute) {
    return res.status(429).json({ error: "rate_limited", retry_after_s: Math.ceil((b.resetAt - nowMs) / 1000) });
  }
  next();
};
app.use("/v1", rateLimit);
app.use("/mcp", rateLimit);

/** Optional API key resolution (keys are for abuse control + metrics, not gating — v1 is free). */
function resolveKey(req: express.Request): { key_id?: string; error?: string } {
  return resolveApiKey(db, keyFromHeaders(req.headers));
}

/* ------------------------------------------------------------------ */
/* Ops auth: when OPS_TOKEN is set, the console and its API require it */
/* (Basic — any username, token as password — or Bearer). Agent-facing */
/* surfaces (/mcp, /v1) and /status pages stay public by design.       */
/* ------------------------------------------------------------------ */
const tokenMatches = (presented: string) => {
  const a = Buffer.from(presented);
  const b = Buffer.from(config.opsToken!);
  return a.length === b.length && timingSafeEqual(a, b);
};
const opsAuth: express.RequestHandler = (req, res, next) => {
  if (!config.opsToken) return next();
  const header = req.header("authorization") ?? "";
  if (header.startsWith("Bearer ") && tokenMatches(header.slice(7).trim())) return next();
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString();
    const password = decoded.slice(decoded.indexOf(":") + 1);
    if (tokenMatches(password)) return next();
  }
  res.setHeader("WWW-Authenticate", 'Basic realm="Registry Ops Console"');
  res.status(401).json({ error: "ops_auth_required" });
};

/* ----------------------------------------------------- */
/* Agent-facing MCP endpoint (Streamable HTTP transport)  */
/* ----------------------------------------------------- */
app.use("/mcp", mcpRouter(db));

/* Public discovery: /.well-known/mcp.json + /healthz (crawlable by design). */
app.use(discoveryRouter(db));

/* Public landing page at / (crawlable by design — robots.txt still shields /ops/). */
app.use(landingRouter(db));

/* --------------------------------------------- */
/* Agent-facing REST (mirror of the MCP surface)  */
/* --------------------------------------------- */
// Self-description: GET /v1 (compact index) + /v1/openapi.json (OpenAPI 3.1).
const requestBase = (req: express.Request) =>
  process.env.PUBLIC_BASE_URL ?? `${req.protocol}://${req.get("host")}`;
app.get("/v1", (req, res) => res.json(v1Index(requestBase(req))));
app.get("/v1/openapi.json", (req, res) => res.json(buildOpenApi(requestBase(req))));

app.use("/v1/keys", keysRouter(db)); // self-serve issuance, abuse-guarded (Gate B)

app.get("/v1/merchants", (req, res) => {
  const q = req.query;
  const near = q.lat && q.lng ? { lat: Number(q.lat), lng: Number(q.lng), radius_km: Number(q.radius_km ?? 3) } : undefined;
  try {
    res.json(
      searchMerchants(db, {
        neighborhood: q.neighborhood as string | undefined,
        near,
        cuisine_tags: q.cuisine_tags ? String(q.cuisine_tags).split(",") : undefined,
        attribute_tags: q.attribute_tags ? String(q.attribute_tags).split(",") : undefined,
        price_band_min: q.price_band_min ? Number(q.price_band_min) : undefined,
        price_band_max: q.price_band_max ? Number(q.price_band_max) : undefined,
        open_at: q.open_at as string | undefined,
        bookable_only: q.bookable_only === "true",
        party_size: q.party_size ? Number(q.party_size) : undefined,
        order_by: q.order_by as any,
        limit: q.limit ? Number(q.limit) : undefined,
        offset: q.offset ? Number(q.offset) : undefined,
      }),
    );
  } catch (e) {
    if (e instanceof Error && e.message === "invalid_open_at") return res.status(400).json({ error: "invalid_open_at" });
    throw e;
  }
});

app.get("/v1/merchants/:id", (req, res) => {
  const m = getMerchant(db, req.params.id);
  if (!m) return res.status(404).json({ error: "unknown_merchant" });
  res.json({
    ...m,
    feedback_summary: feedbackSummary(db, req.params.id),
    feedback_history: feedbackHistory(db, req.params.id),
    operational_stats: operationalStats(db, req.params.id),
    source_provenance: getProvenance(db, req.params.id),
  });
});

/** REQ-MCP-5: bulk read for whole-city ingestion — encouraged, not fought. */
app.get("/v1/export/merchants.ndjson", (_req, res) => {
  res.setHeader("content-type", "application/x-ndjson");
  const rows = db.prepare("SELECT * FROM merchants WHERE opt_out = 0 ORDER BY merchant_id").all() as Row[];
  for (const row of rows) res.write(JSON.stringify(rowToMerchant(row)) + "\n");
  res.end();
});

app.get("/v1/meta", (_req, res) => res.json(registryMeta(db)));

/** Public aggregate ops stats (PII-free) — feed for uptime/health monitoring. */
app.get("/v1/stats", (_req, res) => res.json(publicStats(db)));

app.post("/v1/bookings", (req, res) => {
  const auth = resolveKey(req);
  if (auth.error) return res.status(401).json({ error: auth.error });
  // Idempotency-Key header is the REST-conventional spelling of client_reference_id;
  // an explicit body field wins if both are present.
  const body = req.body ?? {};
  const headerRef = req.header("idempotency-key");
  const result = placeBooking(db, {
    ...body,
    ...(body.client_reference_id === undefined && headerRef ? { client_reference_id: headerRef } : {}),
    api_key_id: auth.key_id,
  });
  const status = result.ok ? (result.idempotent_replay ? 200 : 201) : result.error === "client_reference_conflict" ? 409 : 400;
  res.status(status).json(result);
});

app.get("/v1/bookings/:id", (req, res) => {
  const status = bookingStatus(db, req.params.id);
  if (!status) return res.status(404).json({ error: "unknown_booking" });
  const includeEvents = req.query.include_events === "true";
  res.json(includeEvents ? { ...status, events: getBookingEvents(db, req.params.id) } : status);
});

app.post("/v1/bookings/:id/modify", (req, res) => {
  const result = modifyBooking(db, req.params.id, req.body ?? {});
  res.status(result.ok ? 200 : 400).json(result);
});

app.post("/v1/bookings/:id/cancel", (req, res) => {
  const result = cancelBooking(db, req.params.id, req.body?.reason);
  res.status(result.ok ? 200 : 400).json(result);
});

app.post("/v1/bookings/:id/feedback", (req, res) => {
  const result = submitFeedback(db, { ...req.body, booking_id: req.params.id });
  res.status(result.ok ? 201 : 400).json(result);
});

/* ------------------------------- */
/* Status page for the end human   */
/* ------------------------------- */
app.get("/status/:id", (req, res) => {
  const b = getBooking(db, req.params.id);
  if (!b) return res.status(404).send("<h1>Booking not found</h1>");
  const merchant = getMerchant(db, b.merchant_id);
  const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const stateColor: Record<string, string> = { confirmed: "#2e7d32", failed: "#c62828", cancelled: "#757575" };
  res.send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reservation status</title>
<body style="font-family:system-ui;max-width:480px;margin:40px auto;padding:0 16px;color:#222">
<h2 style="margin-bottom:4px">${esc(merchant?.name ?? "Restaurant")}</h2>
<p style="color:#666;margin-top:0">${esc(merchant?.location.address ?? "")}</p>
<p><strong style="color:${stateColor[b.state] ?? "#e65100"};text-transform:uppercase">${esc(b.state)}</strong>
${b.failure_reason ? ` — ${esc(b.failure_reason)}` : ""}</p>
<table style="border-collapse:collapse">
<tr><td style="padding:4px 12px 4px 0;color:#666">Name</td><td>${esc(b.reservation_name)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#666">Party</td><td>${esc(b.party_size)}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#666">Time</td><td>${esc(b.confirmed_time ?? b.requested_time)}</td></tr>
${b.confirmation_code ? `<tr><td style="padding:4px 12px 4px 0;color:#666">Code</td><td><strong>${esc(b.confirmation_code)}</strong></td></tr>` : ""}
${b.merchant_instructions ? `<tr><td style="padding:4px 12px 4px 0;color:#666">Note</td><td>${esc(b.merchant_instructions)}</td></tr>` : ""}
</table></body>`);
});

/* ----------------------- */
/* Ops Console API (§6.5)  */
/* ----------------------- */
app.use("/ops", opsAuth);

const opsMerchantSummary = (merchantId: string) => {
  const row = db.prepare("SELECT merchant_id, name, neighborhood, phone_primary, fulfillment_channel FROM merchants WHERE merchant_id = ?").get(merchantId) as Row;
  return row ?? { merchant_id: merchantId, name: "(unknown)" };
};

app.get("/ops/api/overview", (_req, res) => {
  const one = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as Row).c as number;
  res.json({
    meta: registryMeta(db),
    queue: {
      queued: one("SELECT COUNT(*) c FROM bookings WHERE state = 'queued'"),
      in_progress: one("SELECT COUNT(*) c FROM bookings WHERE state = 'in_progress'"),
      needs_input: one("SELECT COUNT(*) c FROM bookings WHERE state = 'needs_input'"),
      human_queue: one("SELECT COUNT(*) c FROM bookings b JOIN merchants m ON m.merchant_id = b.merchant_id WHERE b.state = 'queued' AND m.fulfillment_channel = 'human_call'"),
    },
    verification_due: verificationQueue(db).length,
    open_complaints: one("SELECT COUNT(*) c FROM complaints WHERE resolved_at IS NULL"),
  });
});

/** REQ-OPS-1: queue view with SLA timers. */
app.get("/ops/api/queue", (_req, res) => {
  const active = db
    .prepare(
      `SELECT b.*, m.name merchant_name, m.neighborhood, m.phone_primary, m.fulfillment_channel
       FROM bookings b JOIN merchants m ON m.merchant_id = b.merchant_id
       WHERE b.state IN ('pending','queued','in_progress','needs_input')
       ORDER BY b.sla_deadline`,
    )
    .all() as Row[];
  const withCalls = active.map((b) => {
    const call = db
      .prepare("SELECT call_id, attempt_no, channel, started_at, taken_over, operator, transcript FROM call_attempts WHERE booking_id = ? ORDER BY attempt_no DESC LIMIT 1")
      .get(b.booking_id) as Row | undefined;
    return {
      ...b,
      needs_input_options: b.needs_input_options ? JSON.parse(b.needs_input_options) : null,
      current_call: call ? { ...call, transcript: JSON.parse(call.transcript) } : null,
    };
  });
  res.json(withCalls);
});

/** Operator claims a human_call booking: creates the attempt and moves it in_progress. */
app.post("/ops/api/bookings/:id/claim", (req, res) => {
  const operator = req.body?.operator ?? "operator";
  const b = getBooking(db, req.params.id);
  if (!b) return res.status(404).json({ error: "unknown_booking" });
  if (b.state !== "queued") return res.status(400).json({ error: `not_in_queue (${b.state})` });
  const callId = randomUUID();
  const attemptNo = b.attempts + 1;
  db.prepare("INSERT INTO call_attempts (call_id, booking_id, attempt_no, channel, started_at, taken_over, operator, transcript) VALUES (?,?,?,?,?,1,?,'[]')").run(
    callId, b.booking_id, attemptNo, "human_call", now(), operator,
  );
  db.prepare("UPDATE bookings SET attempts = ?, updated_at = ? WHERE booking_id = ?").run(attemptNo, now(), b.booking_id);
  transition(db, b.booking_id, "in_progress", { call_id: callId, attempt: attemptNo, channel: "human_call", operator });
  res.json({ ok: true, call_id: callId });
});

/** REQ-FUL-4 / REQ-OPS-2: one-click takeover of a live voice-agent call. */
app.post("/ops/api/calls/:callId/takeover", (req, res) => {
  const operator = req.body?.operator ?? "operator";
  const r = db.prepare("UPDATE call_attempts SET taken_over = 1, operator = ? WHERE call_id = ? AND ended_at IS NULL").run(operator, req.params.callId);
  if (r.changes === 0) return res.status(400).json({ error: "call_not_live" });
  res.json({ ok: true });
});

app.get("/ops/api/calls/:callId", (req, res) => {
  const call = db.prepare("SELECT * FROM call_attempts WHERE call_id = ?").get(req.params.callId) as Row | undefined;
  if (!call) return res.status(404).json({ error: "unknown_call" });
  res.json({ ...call, transcript: JSON.parse(call.transcript) });
});

/** Operator wrap-up: disposition + outcome (used after takeover or for human_call bookings). */
app.post("/ops/api/calls/:callId/resolve", (req, res) => {
  const call = db.prepare("SELECT * FROM call_attempts WHERE call_id = ?").get(req.params.callId) as Row | undefined;
  if (!call) return res.status(404).json({ error: "unknown_call" });
  if (call.ended_at) return res.status(400).json({ error: "call_already_resolved" });
  const { outcome, confirmed_time, merchant_instructions, failure_reason, offered_times, disposition_code, operator, note } = req.body ?? {};

  db.prepare("UPDATE call_attempts SET disposition_code = ?, operator = COALESCE(?, operator) WHERE call_id = ?").run(
    disposition_code ?? outcome, operator ?? null, req.params.callId,
  );
  if (note) appendTranscript(db, call.call_id, "operator", note);

  const map: Record<string, any> = {
    confirmed: { kind: "confirmed", confirmed_time: confirmed_time, merchant_instructions },
    no_answer: { kind: "no_answer" },
    counter_offer: { kind: "counter_offer", offered_times: offered_times ?? [] },
    failed: { kind: "failed", reason: failure_reason ?? "merchant_declined" },
  };
  const mapped = map[outcome];
  if (!mapped) return res.status(400).json({ error: "outcome must be confirmed | no_answer | counter_offer | failed" });
  if (outcome === "confirmed" && !confirmed_time) return res.status(400).json({ error: "confirmed_time required" });
  finishAttempt(db, call.call_id, call.booking_id, call.attempt_no, mapped);
  res.json({ ok: true, booking: bookingStatus(db, call.booking_id) });
});

app.get("/ops/api/bookings", (req, res) => {
  const state = req.query.state as string | undefined;
  const rows = db
    .prepare(
      `SELECT b.booking_id, b.state, b.failure_reason, b.party_size, b.requested_time, b.confirmed_time,
              b.reservation_name, b.attempts, b.created_at, b.updated_at, m.name merchant_name, m.neighborhood
       FROM bookings b JOIN merchants m ON m.merchant_id = b.merchant_id
       ${state ? "WHERE b.state = ?" : ""}
       ORDER BY b.created_at DESC LIMIT 200`,
    )
    .all(...(state ? [state] : [])) as Row[];
  res.json(rows);
});

app.get("/ops/api/bookings/:id", (req, res) => {
  const b = getBooking(db, req.params.id);
  if (!b) return res.status(404).json({ error: "unknown_booking" });
  const calls = (db.prepare("SELECT * FROM call_attempts WHERE booking_id = ? ORDER BY attempt_no").all(req.params.id) as Row[]).map(
    (c) => ({ ...c, transcript: JSON.parse(c.transcript) }),
  );
  res.json({
    ...b,
    needs_input_options: b.needs_input_options ? JSON.parse(b.needs_input_options) : null,
    merchant: opsMerchantSummary(b.merchant_id),
    events: getBookingEvents(db, req.params.id),
    calls,
  });
});

app.get("/ops/api/merchants", (req, res) => {
  const q = ((req.query.q as string) ?? "").toLowerCase();
  const filter = req.query.filter as string | undefined;
  let rows = db.prepare("SELECT * FROM merchants ORDER BY name").all() as Row[];
  if (q) rows = rows.filter((r) => r.name.toLowerCase().includes(q) || r.neighborhood.toLowerCase().includes(q));
  if (filter === "unverified") rows = rows.filter((r) => !r.phone_verified_at);
  if (filter === "opted_out") rows = rows.filter((r) => r.opt_out);
  if (filter === "human_call") rows = rows.filter((r) => r.fulfillment_channel === "human_call");
  res.json(rows.slice(0, 100).map(rowToMerchant));
});

app.get("/ops/api/merchants/:id", (req, res) => {
  const m = getMerchant(db, req.params.id);
  if (!m) return res.status(404).json({ error: "unknown_merchant" });
  res.json({
    ...m,
    human_call_flag_reason: (db.prepare("SELECT human_call_flag_reason r FROM merchants WHERE merchant_id = ?").get(req.params.id) as Row).r,
    feedback_summary: feedbackSummary(db, req.params.id),
    operational_stats: operationalStats(db, req.params.id),
    provenance: getProvenance(db, req.params.id),
    verification_calls: db.prepare("SELECT * FROM verification_calls WHERE merchant_id = ? ORDER BY called_at DESC").all(req.params.id),
    complaints: db.prepare("SELECT * FROM complaints WHERE merchant_id = ? ORDER BY opened_at DESC").all(req.params.id),
  });
});

/** REQ-OPS-3: merchant record editing with provenance. */
app.patch("/ops/api/merchants/:id", (req, res) => {
  const { field, value, operator, note } = req.body ?? {};
  try {
    updateMerchantField(db, req.params.id, field, value, "ops_edit", `operator=${operator ?? "?"}${note ? `: ${note}` : ""}`);
    res.json({ ok: true, merchant: getMerchant(db, req.params.id) });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

app.post("/ops/api/merchants/:id/verify", (req, res) => {
  const { operator, outcome, notes } = req.body ?? {};
  if (!operator || !outcome) return res.status(400).json({ error: "operator and outcome required" });
  recordVerification(db, req.params.id, operator, outcome, notes);
  res.json({ ok: true, merchant: getMerchant(db, req.params.id) });
});

/** REQ-OPS-5 / REQ-ING-4: opt-out with same-day SLA. */
app.post("/ops/api/merchants/:id/optout", (req, res) => {
  setOptOut(db, req.params.id, req.body?.notes);
  res.json({ ok: true, merchant: getMerchant(db, req.params.id) });
});

app.post("/ops/api/merchants/:id/complaint", (req, res) => {
  db.prepare("INSERT INTO complaints (merchant_id, kind, notes, opened_at) VALUES (?,?,?,?)").run(
    req.params.id, "complaint", req.body?.notes ?? null, now(),
  );
  res.json({ ok: true });
});

/** REQ-FUL-9: annoyance signal; two strikes auto-route to human_call. */
app.post("/ops/api/merchants/:id/annoyance", (req, res) => {
  recordAnnoyance(db, req.params.id, req.body?.note ?? "annoyance signal");
  res.json({ ok: true, merchant: getMerchant(db, req.params.id) });
});

app.get("/ops/api/verification-queue", (_req, res) => res.json(verificationQueue(db)));

app.get("/ops/api/complaints", (_req, res) => {
  res.json(
    db.prepare(
      `SELECT c.*, m.name merchant_name FROM complaints c JOIN merchants m ON m.merchant_id = c.merchant_id
       ORDER BY c.resolved_at IS NOT NULL, c.opened_at DESC LIMIT 100`,
    ).all(),
  );
});

app.post("/ops/api/complaints/:id/resolve", (req, res) => {
  db.prepare("UPDATE complaints SET resolved_at = ?, resolution = ? WHERE id = ?").run(
    now(), req.body?.resolution ?? "resolved", req.params.id,
  );
  res.json({ ok: true });
});

/** REQ-OPS-4: disposition analytics + success-criteria dashboard (§2). */
app.get("/ops/api/analytics", (_req, res) => {
  const rows = (sql: string, ...args: unknown[]) => db.prepare(sql).all(...args) as Row[];
  const one = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as Row) ?? {};

  const terminal = one("SELECT COUNT(*) c FROM bookings WHERE state IN ('confirmed','failed')").c ?? 0;
  const confirmed = one("SELECT COUNT(*) c FROM bookings WHERE state = 'confirmed'").c ?? 0;

  const confirmTimes = rows(
    `SELECT (julianday(e.at) - julianday(b.created_at)) * 24 * 60 AS mins
     FROM bookings b JOIN booking_events e ON e.booking_id = b.booking_id AND e.to_state = 'confirmed'
     WHERE b.state = 'confirmed'`,
  ).map((r) => r.mins).sort((a, b) => a - b);
  const median = confirmTimes.length ? confirmTimes[Math.floor(confirmTimes.length / 2)] : null;

  const voiceCalls = one("SELECT COUNT(*) c FROM call_attempts WHERE channel = 'voice_agent' AND outcome IS NOT NULL").c ?? 0;
  const contained = one("SELECT COUNT(*) c FROM call_attempts WHERE channel = 'voice_agent' AND outcome IS NOT NULL AND taken_over = 0").c ?? 0;

  res.json({
    success_criteria: {
      completion_rate_pct: terminal ? Math.round((confirmed / terminal) * 1000) / 10 : null,
      completion_rate_target_pct: 70,
      median_confirmation_minutes: median !== null ? Math.round(median * 10) / 10 : null,
      median_confirmation_target_minutes: 10,
      distinct_developers_with_booking: (one("SELECT COUNT(DISTINCT api_key_id) c FROM bookings WHERE state = 'confirmed' AND api_key_id IS NOT NULL").c ?? 0),
    },
    failure_reasons: rows("SELECT failure_reason reason, COUNT(*) c FROM bookings WHERE state = 'failed' GROUP BY failure_reason ORDER BY c DESC"),
    voice_agent: {
      calls: voiceCalls,
      containment_rate_pct: voiceCalls ? Math.round((contained / voiceCalls) * 1000) / 10 : null,
      containment_target_pct: 60,
    },
    per_operator: rows(
      "SELECT operator, COUNT(*) calls, SUM(CASE WHEN outcome = 'confirmed' THEN 1 ELSE 0 END) confirmed FROM call_attempts WHERE operator IS NOT NULL AND outcome IS NOT NULL GROUP BY operator ORDER BY calls DESC",
    ),
    dispositions: rows("SELECT outcome, channel, COUNT(*) c FROM call_attempts WHERE outcome IS NOT NULL GROUP BY outcome, channel ORDER BY c DESC"),
    freshness: registryMeta(db).freshness,
  });
});

/** Demo helper: place a booking from the console (simulates an agent's place_booking call). */
app.post("/ops/api/demo/place-booking", (req, res) => {
  const bookable = db
    .prepare(
      `SELECT merchant_id FROM merchants
       WHERE phone_verified_at IS NOT NULL AND opt_out = 0 AND requires_deposit = 0
         AND reservation_policy IN ('phone_reservations','accepts_reservations')
         ${req.body?.channel ? "AND fulfillment_channel = ?" : ""}
       ORDER BY RANDOM() LIMIT 1`,
    )
    .get(...(req.body?.channel ? [req.body.channel] : [])) as Row | undefined;
  if (!bookable) return res.status(400).json({ error: "no bookable merchants" });
  const names = ["Alex Chen", "Sam Rivera", "Jordan Lee", "Priya Patel", "Marcus Webb", "Nina Alvarez"];
  const when = new Date(Date.now() + (24 + Math.floor(Math.random() * 72)) * 3600_000);
  when.setUTCHours(18 + Math.floor(Math.random() * 3), Math.random() < 0.5 ? 0 : 30, 0, 0);
  const result = placeBooking(db, {
    merchant_id: bookable.merchant_id,
    party_size: 2 + Math.floor(Math.random() * 4),
    datetime: when.toISOString().slice(0, 16),
    window_minutes: 60,
    accept_within_window: Math.random() < 0.5,
    reservation_name: names[Math.floor(Math.random() * names.length)],
    special_requests: Math.random() < 0.3 ? "Quiet table if possible, please" : undefined,
  });
  res.json(result);
});

/* --------------- */
/* Ops Console SPA */
/* --------------- */
// Served under /ops/ (the root is the public landing page). Inherits opsAuth
// from the /ops mount above; asset paths in index.html are relative, so they
// resolve to /ops/app.js etc. without changes.
app.use("/ops", express.static(join(here, "..", "ops", "public")));

// Gate B: on Fly (FLY_APP_NAME is set by the runtime) the console must never
// come up open — fail the boot instead of serving merchant editing + live-call
// takeover to the internet. Deploy health checks catch this before cutover.
if (process.env.FLY_APP_NAME && !config.opsToken) {
  console.error("FATAL: running on Fly without OPS_TOKEN — refusing to serve the Ops Console unauthenticated. Set it: fly secrets set OPS_TOKEN=$(openssl rand -hex 24)");
  process.exit(1);
}

const stop = startWorker(db);
process.on("SIGINT", () => {
  stop();
  process.exit(0);
});

app.listen(config.apiPort, () => {
  console.log(`Registry v1 running:
  Agent MCP        http://localhost:${config.apiPort}/mcp  (Streamable HTTP — remote agents connect here)
  Agent REST API   http://localhost:${config.apiPort}/v1   (mirror of the MCP tools)
  Landing page     http://localhost:${config.apiPort}/     (public fact page)
  Ops Console      http://localhost:${config.apiPort}/ops/ ${config.opsToken ? "(OPS_TOKEN auth ON)" : "(OPEN — set OPS_TOKEN before exposing to the internet)"}
  Status pages     http://localhost:${config.apiPort}/status/:booking_id
  Local MCP        npm run mcp   (stdio; shares the same registry DB)
  City: ${config.launchCity} · demo acceleration ${config.demoAccelerate ? "ON" : "off"}`);
  if (!config.opsToken) {
    console.warn("WARNING: OPS_TOKEN is not set — the Ops Console (merchant editing, call takeover) is unauthenticated. Required for internet deployment: see docs/deployment.md.");
  }
});
