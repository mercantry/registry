/**
 * Public landing page — GET / (note 001: presence + credibility; REQ-DST-1).
 *
 * The root is a machine-first fact page: static-fast plain HTML, no client
 * JS, live stats injected server-side from the same DB the agents query.
 * Copy follows the landing-page template (canonical sentence, honesty block,
 * three differentiating facts, JSON-LD graph). Honest by design, same rules
 * as /llms.txt and /.well-known/mcp.json:
 *
 *  - coverage derives from the live DB — a city can never appear here until
 *    it is actually served (and opted-out/sandbox rows never count);
 *  - data status and fulfillment liveness derive from state/config, so the
 *    page cannot promise a booking channel that isn't live;
 *  - never 500s: serves the last-good render if a fresh one fails.
 *
 * Unauthenticated on purpose: it exists to be crawled. The Ops Console,
 * which previously occupied /, now lives under /ops/ (see server.ts).
 */
import type { Database } from "better-sqlite3";
import express from "express";
import { config } from "../config.js";
import { registryMeta } from "../registry/merchants.js";

const REPO_URL = "https://github.com/mercantry/registry";
const CANONICAL =
  "Mercantry is an open commerce registry for AI agents — structured merchant data, honest signals, and real-world booking fulfillment.";
const CACHE_TTL_MS = 60_000;

const fmt = (n: number) => n.toLocaleString("en-US");
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Same served-cities predicate as the discovery surfaces (sandbox + opt-out never count). */
function cityCoverage(db: Database): { city: string; merchant_count: number }[] {
  return (
    db
      .prepare("SELECT city, COUNT(*) c FROM merchants WHERE sandbox = 0 AND opt_out = 0 GROUP BY city ORDER BY city")
      .all() as { city: string; c: number }[]
  ).map((r) => ({ city: r.city, merchant_count: r.c }));
}

/** "Hong Kong" · "Hong Kong and Tokyo" · "Hong Kong, Los Angeles, and Tokyo". */
function cityList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function jsonLd(base: string, realCount: number, cities: { city: string }[]): string {
  const graph = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${base}/#org`,
        name: "Mercantry",
        url: base,
        description: CANONICAL,
        sameAs: [REPO_URL],
      },
      {
        "@type": "WebAPI",
        name: "Mercantry Registry API",
        provider: { "@id": `${base}/#org` },
        documentation: `${base}/v1/openapi.json`,
        termsOfService: `${REPO_URL}/blob/main/docs/faq.md`,
      },
      ...(realCount > 0
        ? [
            {
              "@type": "Dataset",
              name: `Mercantry merchant corpus (${cities.map((c) => c.city).join(", ")})`,
              description:
                "Openly licensed merchant records with per-field provenance; per-source licenses are published in each release manifest.",
              creator: { "@id": `${base}/#org` },
              distribution: {
                "@type": "DataDownload",
                encodingFormat: "application/x-ndjson",
                contentUrl: `${base}/v1/export/merchants.ndjson`,
              },
            },
          ]
        : []),
    ],
  };
  // </script> inside JSON would close the tag early; < keeps the JSON valid.
  return JSON.stringify(graph).replaceAll("<", "\\u003c");
}

function renderLanding(db: Database, base: string): string {
  const meta = registryMeta(db);
  const cities = cityCoverage(db);
  const realCount = cities.reduce((s, r) => s + r.merchant_count, 0);
  const humanCallLive = config.fulfillment.liveChannels.includes("human_call");
  const win = config.fulfillment.operatorWindow;

  const coverageLine = realCount
    ? `<strong>${fmt(realCount)}</strong> merchants across ${esc(cityList(cities.map((c) => c.city)))}.`
    : `Sandbox-only preview — no real corpus imported yet (${fmt(meta.sandbox_count)} deterministic test merchants).`;

  const dataStatus = realCount
    ? `Search/read data is a real, QA-gated corpus (${fmt(realCount)} merchants)`
    : "Search/read data is synthetic demo data — real corpus in import";

  const fulfillmentLine = humanCallLive
    ? `Fulfillment is human-operated (${esc(win.start)}–${esc(win.end)} ${esc(win.timezone)}). Bookings queue honestly and auto-fail at 24&nbsp;h rather than pretending to be instant.`
    : `Real-merchant fulfillment is <strong>not live yet</strong> — <code>place_booking</code> on a real merchant returns <code>fulfillment_not_live</code>. When it launches it will be human-operated (${esc(win.start)}–${esc(win.end)} ${esc(win.timezone)}), queueing honestly with a 24&nbsp;h auto-fail.`;

  const doc = (path: string) => `${REPO_URL}/blob/main/${path}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mercantry — open commerce registry for AI agents</title>
<meta name="description" content="${esc(CANONICAL)}">
<link rel="canonical" href="${esc(base)}/">
<style>
  body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#1a1a1a;line-height:1.55}
  h1{margin-bottom:4px}
  pre{background:#f4f4f4;border:1px solid #ddd;border-radius:6px;padding:10px 14px;overflow-x:auto}
  code{font-size:.92em}
  .honesty{border-left:4px solid #e65100;padding:2px 16px;background:#fff8f2;border-radius:0 6px 6px 0}
  .links,footer{color:#555;font-size:.92em}
  footer{border-top:1px solid #ddd;margin-top:32px;padding-top:12px}
  @media (prefers-color-scheme: dark){
    body{background:#111;color:#e8e8e8}
    pre{background:#1c1c1c;border-color:#333}
    .honesty{background:#1d1712}
    .links,footer{color:#aaa}
    footer{border-color:#333}
    a{color:#8ab4f8}
  }
</style>
</head>
<body>
<h1>Mercantry</h1>
<p><strong>${esc(CANONICAL)}</strong></p>
<p>${coverageLine} No ranking, ever. Per-field provenance. Openly licensed — cache it, embed it, train on it.
Built and operated by a team of AI agents, with human oversight for legal and irreversible decisions. Apache-2.0.</p>

<p><strong>Connect your agent (one line):</strong></p>
<pre><code>claude mcp add --transport http mercantry ${esc(base)}/mcp</code></pre>
<p><strong>First query in one curl (no key needed):</strong></p>
<pre><code>curl "${esc(base)}/v1/merchants?bookable_only=false&amp;limit=3"</code></pre>

<div class="honesty">
<ul>
<li>${dataStatus} — verify live state anytime: <code>GET /v1/meta</code>.</li>
<li>Real bookings are accepted <strong>only</strong> for phone-verified <code>bookable</code> merchants; everything else is discovery-only and marked <code>unverified</code>.</li>
<li>${fulfillmentLine}</li>
<li><code>sandbox: true</code> merchants are safe test targets with deterministic outcomes — they never dial a real restaurant.</li>
<li>Nothing in the calling spec operates until legal review completes (see <a href="${doc("docs/requirements.md")}">the spec</a>).</li>
</ul>
</div>

<ol>
<li><strong>License-to-remember</strong> — the only merchant dataset your agent's operator may legally cache, embed, and train on. Bulk export encouraged: <code>/v1/export/merchants.ndjson</code>.</li>
<li><strong>No ranking exists in the schema</strong> — deterministic order, raw signals, auditable incentives. Your model brings taste; Mercantry brings truth.</li>
<li><strong>Universal fulfillment</strong> — the booking rail needs no merchant-side integration; coverage grows by verification, not sales.</li>
</ol>

<p class="links">
<a href="${doc("docs/faq.md")}">FAQ</a> ·
<a href="${doc("docs/mcp-tools.md")}">MCP tools</a> ·
<a href="/v1">API index</a> ·
<a href="/v1/openapi.json">OpenAPI</a> ·
<a href="/llms.txt">llms.txt</a> ·
<a href="/.well-known/mcp.json">MCP manifest</a> ·
<a href="/.well-known/agent-card.json">Agent card</a> ·
<a href="${REPO_URL}">GitHub</a> ·
<a href="/healthz">Status</a>
</p>

<footer>Mercantry — an open commerce registry for AI agents.
${new Date().toISOString()} · schema ${esc(config.schemaVersion)} · <a href="${doc("LICENSE")}">Apache-2.0</a></footer>
<script type="application/ld+json">${jsonLd(base, realCount, cities)}</script>
</body>
</html>
`;
}

/** Fail-safe body if a render has never succeeded (canonical sentence only). */
const FALLBACK = `<!doctype html><meta charset="utf-8"><title>Mercantry</title><h1>Mercantry</h1><p>${CANONICAL}</p><p>Live stats: GET /v1/meta</p>`;

/** Base URL for absolute links: PUBLIC_BASE_URL env wins, else derived per-request. */
function baseUrl(req: express.Request): string {
  if (config.publicBaseUrl) return config.publicBaseUrl.replace(/\/$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

export function landingRouter(db: Database): express.Router {
  const router = express.Router();
  // Last-good cache (60s TTL), same never-500 guarantee as /llms.txt.
  let cache: { body: string; base: string; at: number } | undefined;
  router.get("/", (req, res) => {
    const base = baseUrl(req);
    const nowMs = Date.now();
    if (!cache || cache.base !== base || nowMs - cache.at > CACHE_TTL_MS) {
      try {
        cache = { body: renderLanding(db, base), base, at: nowMs };
      } catch (e) {
        console.error("landing render failed; serving fallback:", e);
        cache = { body: cache?.body ?? FALLBACK, base, at: nowMs };
      }
    }
    res.type("html").send(cache.body);
  });
  return router;
}
