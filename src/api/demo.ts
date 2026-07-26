/**
 * Demo & reviewer guide — GET /demo.
 *
 * Directories (the Claude Connector Directory among them) ask a submission for
 * a standing demo account with sample data so a reviewer can exercise the
 * connector end to end. Our access model makes the literal "account" the wrong
 * artifact — reads and sandbox bookings need no credential at all (keys are
 * optional, for attribution and abuse control, never gating) — so what a
 * reviewer actually needs is: live test-merchant ids, a copy-pasteable
 * sequence, and a guarantee about what each call will return. That is this
 * page, and it is deliberately public rather than a private hand-off: anything
 * a reviewer can do here, any agent can already do.
 *
 * Same honesty rules as /, /privacy and /llms.txt:
 *
 *  - the sample merchants are read from the live database at render time, so a
 *    published id is one this deployment can actually book (never a fixture
 *    that has since gone opt_out or unverified);
 *  - the suggested datetime is computed in the merchant's own zone and inside
 *    the peak-avoidance horizon, so the walkthrough really does dispatch on
 *    the next worker tick instead of quietly waiting out a meal rush;
 *  - what is live and what is not is read from config, so the page cannot
 *    promise a booking channel that isn't switched on;
 *  - never 500s: serves the last-good render if a fresh one fails.
 */
import type { Database } from "better-sqlite3";
import express from "express";
import { config } from "../config.js";
import { deriveBookable, registryMeta } from "../registry/merchants.js";
import { zoneDateStr, zoneHHMM } from "../registry/time.js";
import { SANDBOX_OUTCOMES } from "../registry/types.js";

const REPO_URL = "https://github.com/mercantry/registry";
const CANONICAL =
  "Mercantry is an open commerce registry for AI agents — structured merchant data, honest signals, and real-world booking fulfillment.";
const CACHE_TTL_MS = 60_000;
const SAMPLE_COUNT = 3;

const fmt = (n: number) => n.toLocaleString("en-US");
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** What each forced outcome does to the booking state machine, in the caller's terms. */
const OUTCOME_EFFECTS: Record<string, string> = {
  confirmed: "The call succeeds at the requested time: <code>queued → in_progress → confirmed</code>, with a confirmation code.",
  no_answer: `Nobody picks up. The booking retries up to ${config.fulfillment.maxCallAttempts} times, then ends <code>failed</code> with <code>failure_reason: no_answer</code>.`,
  counter_offer: "The merchant offers two alternative times. With <code>accept_within_window</code> and a wide enough <code>window_minutes</code> the nearer one auto-confirms; otherwise the booking pauses in <code>needs_input</code> for you to resolve with <code>modify_booking</code>.",
  fully_booked: "Terminal <code>failed</code> with <code>failure_reason: fully_booked</code>.",
  merchant_declined: "Terminal <code>failed</code> with <code>failure_reason: merchant_declined</code>.",
  bad_data: "Terminal <code>failed</code> with <code>failure_reason: bad_data</code> — the record the call was placed against was wrong.",
};

interface Sample {
  merchant_id: string;
  name: string;
  city: string;
  timezone: string;
  max_party_size: number;
}

/**
 * Bookable sandbox merchants, ordered deterministically so the ids on this page
 * are stable between renders. `deriveBookable` is the same predicate the
 * booking path applies, so anything listed here really is bookable right now.
 */
function sampleMerchants(db: Database): Sample[] {
  const rows = db
    .prepare(
      `SELECT merchant_id, name, city, timezone, max_party_size, phone_verified_at, opt_out,
              reservation_policy, requires_deposit, verification_status
         FROM merchants WHERE sandbox = 1 AND opt_out = 0 ORDER BY merchant_id`,
    )
    .all() as Record<string, any>[];
  return rows
    .filter((r) => deriveBookable(r as any))
    .slice(0, SAMPLE_COUNT)
    .map((r) => ({
      merchant_id: r.merchant_id,
      name: r.name,
      city: r.city,
      timezone: r.timezone || config.timezone,
      max_party_size: r.max_party_size,
    }));
}

/**
 * A datetime the walkthrough can actually use: the merchant's own wall clock,
 * ~2h out. Inside `peakAvoidanceHorizonMs` the worker dispatches immediately
 * (REQ-FUL-5 defers only bookings further out), so the simulated call starts
 * on the next tick rather than at the end of a meal rush.
 */
function suggestedDatetime(timezone: string): string {
  const at = new Date(Date.now() + 2 * 60 * 60_000);
  return `${zoneDateStr(at, timezone)}T${zoneHHMM(at, timezone)}`;
}

function renderDemo(db: Database, base: string): string {
  const meta = registryMeta(db);
  const samples = sampleMerchants(db);
  const sample = samples[0];
  const humanCallLive = config.fulfillment.liveChannels.includes("human_call");
  const win = config.fulfillment.operatorWindow;
  const doc = (path: string) => `${REPO_URL}/blob/main/${path}`;

  const when = sample ? suggestedDatetime(sample.timezone) : "2026-07-26T19:00";
  const mid = sample?.merchant_id ?? "<merchant_id from the search above>";

  const sampleTable = samples.length
    ? `<table>
<tr><th>merchant_id</th><th>Name</th><th>City</th><th>Max party</th></tr>
${samples
  .map(
    (s) =>
      `<tr><td><code>${esc(s.merchant_id)}</code></td><td>${esc(s.name)}</td><td>${esc(s.city)}</td><td>${esc(s.max_party_size)}</td></tr>`,
  )
  .join("\n")}
</table>
<p class="meta">Read from this deployment's database at render time — ${fmt(meta.sandbox_count)} sandbox merchants exist in total; these ${samples.length} are bookable right now. Search them yourself with <code>GET /v1/merchants?city=${encodeURIComponent(samples[0].city)}&amp;bookable_only=true</code>.</p>`
    : `<p><strong>This deployment currently has no bookable sandbox merchant</strong> (${fmt(meta.sandbox_count)} sandbox records, none passing the bookable predicate), so the walkthrough below cannot be completed against it as written. Every other surface on this page is unaffected.</p>`;

  const fulfillmentLine = humanCallLive
    ? `Real-merchant fulfillment is live and human-operated (${esc(win.start)}–${esc(win.end)} ${esc(win.timezone)}); those bookings queue until an operator works them.`
    : `Real-merchant fulfillment is <strong>not live</strong>: <code>place_booking</code> against a real merchant returns <code>fulfillment_not_live</code>. Only sandbox merchants complete the loop today.`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Demo &amp; reviewer guide — Mercantry</title>
<meta name="description" content="Exercise the Mercantry registry end to end in about two minutes: no credentials, live sandbox merchant ids, and forced booking outcomes.">
<link rel="canonical" href="${esc(base)}/demo">
<style>
  body{font-family:system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#1a1a1a;line-height:1.55}
  h1{margin-bottom:4px}
  h2{margin-top:32px}
  pre{background:#f4f4f4;border:1px solid #ddd;border-radius:6px;padding:10px 14px;overflow-x:auto}
  code{font-size:.92em}
  table{border-collapse:collapse;width:100%;margin:12px 0}
  th,td{border:1px solid #ddd;padding:6px 10px;text-align:left;vertical-align:top;font-size:.94em}
  th{background:#f4f4f4}
  .honesty{border-left:4px solid #e65100;padding:2px 16px;background:#fff8f2;border-radius:0 6px 6px 0}
  .meta,.links,footer{color:#555;font-size:.92em}
  footer{border-top:1px solid #ddd;margin-top:32px;padding-top:12px}
  @media (prefers-color-scheme: dark){
    body{background:#111;color:#e8e8e8}
    pre{background:#1c1c1c;border-color:#333}
    th{background:#1c1c1c}
    th,td{border-color:#333}
    .honesty{background:#1d1712}
    .meta,.links,footer{color:#aaa}
    footer{border-color:#333}
    a{color:#8ab4f8}
  }
</style>
</head>
<body>
<h1>Demo &amp; reviewer guide</h1>
<p><strong>${esc(CANONICAL)}</strong> This page is the standing demo: everything a reviewer or a new integrator needs to drive the whole booking loop, start to finish, in about two minutes.</p>

<h2>1. Credentials: there are none to issue</h2>
<p>Reads and sandbox bookings are open. An API key is <em>optional</em> — it attributes bookings and buys abuse-control headroom, and it never gates a read. There is no login, no dashboard and no paid tier, so a shared "reviewer account" would grant nothing this page doesn't.</p>
<p>If your process needs a credential on file, mint your own in one call (instant, free, no approval):</p>
<pre><code>curl -sX POST ${esc(base)}/v1/keys -H 'content-type: application/json' \\
  -d '{"developer_name":"Directory review","contact":"you@example.com"}'</code></pre>
<p class="meta">Send it back as <code>x-api-key: &lt;key&gt;</code> or <code>Authorization: Bearer &lt;key&gt;</code>. Rate limit: ${fmt(config.mcp.rateLimitPerMinute)} requests/minute, keyed or anonymous; 429s carry <code>Retry-After</code>. What a key stores is itemized on the <a href="/privacy">privacy page</a>.</p>

<h2>2. Connect</h2>
<pre><code>claude mcp add --transport http mercantry ${esc(base)}/mcp</code></pre>
<p>Or drive it directly: MCP Streamable HTTP at <code>${esc(base)}/mcp</code>, REST mirror at <code>${esc(base)}/v1</code> (<a href="/v1/openapi.json">OpenAPI</a>). Tools: <code>search_merchants</code>, <code>get_merchant</code>, <code>get_availability</code>, <code>place_booking</code>, <code>get_booking_status</code>, <code>modify_booking</code>, <code>cancel_booking</code>, <code>submit_feedback</code>, <code>get_registry_meta</code>.</p>

<h2>3. Sample data: the sandbox merchants</h2>
<p>Sandbox merchants are synthetic records kept for exactly this purpose — the test cards of this registry. They carry <code>sandbox: true</code>, they are excluded from every published coverage number, and the simulated call never dials a phone. They are the only merchants that complete a booking today.</p>
${sampleTable}

<h2>4. The walkthrough — four calls</h2>
<p>Search, book, watch it confirm, then cancel. Swap in any sandbox <code>merchant_id</code> above.</p>
<pre><code># a. find bookable sandbox merchants
curl -s "${esc(base)}/v1/merchants?bookable_only=true&amp;limit=3"

# b. book one, and force the outcome you want to see
curl -sX POST ${esc(base)}/v1/bookings -H 'content-type: application/json' -d '{
  "merchant_id": "${esc(mid)}",
  "party_size": 2,
  "datetime": "${esc(when)}",
  "reservation_name": "Directory review",
  "window_minutes": 60,
  "accept_within_window": true,
  "client_reference_id": "review-001",
  "sandbox_outcome": "confirmed"
}'

# c. poll until terminal (the simulated call takes ~${Math.round((config.fulfillment.simLineDelayMs * 5) / 1000)}s)
curl -s ${esc(base)}/v1/bookings/&lt;booking_id&gt;

# d. cancel it (also the honest thing to do with any booking you abandon)
curl -sX POST ${esc(base)}/v1/bookings/&lt;booking_id&gt;/cancel \\
  -H 'content-type: application/json' -d '{"reason":"demo complete"}'</code></pre>
<p class="meta">The suggested <code>datetime</code> is the merchant's own wall clock about two hours out. Times further than ${Math.round(config.fulfillment.peakAvoidanceHorizonMs / 3_600_000)}h ahead politely wait out the merchant's meal rush before the call is placed (REQ-FUL-5), which is correct behavior but a dull demo. Retry safety: reusing a <code>client_reference_id</code> replays the same booking rather than double-booking — with different parameters it is rejected as <code>client_reference_conflict</code>.</p>

<h2>5. Forced outcomes (sandbox only)</h2>
<p>Pass <code>sandbox_outcome</code> on <code>place_booking</code> to walk a chosen branch of the state machine on demand, instead of taking the pseudo-random draw a real call would give you:</p>
<table>
<tr><th>sandbox_outcome</th><th>What happens</th></tr>
${SANDBOX_OUTCOMES.map((o) => `<tr><td><code>${esc(o)}</code></td><td>${OUTCOME_EFFECTS[o]}</td></tr>`).join("\n")}
</table>
<p class="meta">Omit the field and the outcome is drawn deterministically from the booking id, so any single booking always replays the same way. The field is rejected with <code>sandbox_outcome_requires_sandbox_merchant</code> for real merchants — nobody gets to script a real restaurant's answer. Note that <code>no_answer</code> is deliberately slow: retries are ${Math.round(config.fulfillment.retryDelayMs / 60_000) || 1} minute(s) apart in this deployment.</p>

<h2>6. What is real, and what isn't</h2>
<div class="honesty">
<ul>
<li>${fulfillmentLine}</li>
<li>Search and read data ${meta.real_count > 0 ? `is a real, QA-gated corpus of <strong>${fmt(meta.real_count)}</strong> merchants` : "is sandbox-only in this deployment — no real corpus imported yet"} — verify anytime with <code>GET /v1/meta</code>.</li>
<li>Sandbox merchants are synthetic and are marked <code>sandbox: true</code> on every surface. No sandbox booking, transcript or confirmation involves a real business.</li>
<li>V1 holds no live table availability. <code>get_availability</code> says so outright: availability is checked on the call, at booking time.</li>
<li>Nothing in the calling specification operates until legal review completes (see <a href="${doc("docs/requirements.md")}">the spec</a>).</li>
</ul>
</div>

<p class="links">
<a href="/">Home</a> ·
<a href="/privacy">Privacy</a> ·
<a href="/v1">API index</a> ·
<a href="/v1/openapi.json">OpenAPI</a> ·
<a href="/llms.txt">llms.txt</a> ·
<a href="/.well-known/mcp.json">MCP manifest</a> ·
<a href="${doc("docs/mcp-tools.md")}">MCP tool reference</a> ·
<a href="${REPO_URL}">GitHub</a> ·
<a href="/healthz">Status</a>
</p>
<footer>Mercantry — an open commerce registry for AI agents. ${new Date().toISOString()} · schema ${esc(config.schemaVersion)}</footer>
</body>
</html>
`;
}

/** Fail-safe body if a render has never succeeded — still enough to run the demo. */
const FALLBACK = `<!doctype html><meta charset="utf-8"><title>Demo — Mercantry</title><h1>Demo &amp; reviewer guide</h1><p>${CANONICAL}</p><p>No credentials are required: reads and sandbox bookings are open, and an API key (POST /v1/keys) is optional. Find test merchants with <code>GET /v1/merchants?bookable_only=true</code> — sandbox merchants (<code>sandbox: true</code>) are the ones that complete a booking, and <code>sandbox_outcome</code> on place_booking forces the simulated result. Full contract: /v1/openapi.json</p>`;

/** Base URL for absolute links: PUBLIC_BASE_URL env wins, else derived per-request. */
function baseUrl(req: express.Request): string {
  if (config.publicBaseUrl) return config.publicBaseUrl.replace(/\/$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

export function demoRouter(db: Database): express.Router {
  const router = express.Router();
  // Last-good cache (60s TTL), same never-500 guarantee as / and /privacy.
  let cache: { body: string; base: string; at: number } | undefined;
  router.get("/demo", (req, res) => {
    const base = baseUrl(req);
    const nowMs = Date.now();
    if (!cache || cache.base !== base || nowMs - cache.at > CACHE_TTL_MS) {
      try {
        cache = { body: renderDemo(db, base), base, at: nowMs };
      } catch (e) {
        console.error("demo render failed; serving fallback:", e);
        cache = { body: cache?.body ?? FALLBACK, base, at: nowMs };
      }
    }
    res.type("html").send(cache.body);
  });
  return router;
}
