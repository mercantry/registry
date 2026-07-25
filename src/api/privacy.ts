/**
 * Public privacy policy — GET /privacy.
 *
 * Two reasons this page exists: agent/connector directories require a public
 * privacy-policy URL before a submission is reviewable, and a registry that
 * asks agents to trust its data owes them a plain statement of what it stores.
 *
 * Same honesty rules as / and /llms.txt, with one extra constraint that drives
 * the design: **the page must never claim less collection than actually
 * happens.** So the collection facts are derived from the live system rather
 * than prose:
 *
 *  - the API-user fields come from `PRAGMA table_info(api_keys)` — a column
 *    added later still appears here (with a generic description) instead of
 *    silently going undisclosed;
 *  - the merchant-source list comes from the release manifests actually
 *    imported (falling back to the licensed-source allowlist in code when no
 *    import ledger exists yet);
 *  - fulfillment, operator-notification and hosting statements read from
 *    config/env, so the page cannot describe a data flow that is switched off
 *    (or hide one that is switched on).
 *
 * A privacy policy is a legal document: until it has had human review, the
 * route serves with a visible draft banner and `noindex`. Setting
 * PRIVACY_POLICY_REVIEWED=1 drops both — that flag is the human sign-off.
 */
import type { Database } from "better-sqlite3";
import express from "express";
import { config } from "../config.js";
import { SOURCE_LICENSES } from "../ingest/types.js";

const REPO_URL = "https://github.com/mercantry/registry";
const ISSUES_URL = `${REPO_URL}/issues`;
const CANONICAL =
  "Mercantry is an open commerce registry for AI agents — structured merchant data, honest signals, and real-world booking fulfillment.";
/** Date this policy's text last changed. Bump it in the same commit as any edit below. */
export const POLICY_UPDATED = "2026-07-25";
const CACHE_TTL_MS = 60_000;

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/**
 * What each api_keys column holds, in the caller's terms. Columns missing from
 * this map are still listed (with a generic note) — disclosure is structural,
 * documentation is best-effort.
 */
const KEY_FIELD_NOTES: Record<string, string> = {
  key_id: "an opaque identifier for the key (this is what a booking is attributed to)",
  api_key: "the key value itself, stored as issued so a presented key can be matched — treat it as a secret",
  developer_name: "the name you supply when minting the key",
  contact: "the contact you supply when minting the key (an email or URL; personal if you supply a personal one)",
  webhook_url: "the optional webhook URL you supply",
  created_ip: "the IP address the mint request came from, used to enforce the per-IP minting cap",
  no_show_count: "a counter of bookings this key did not honor",
  throttled: "whether the key is currently throttled for abuse",
  created_at: "when the key was issued",
};

interface Source {
  source: string;
  license: string;
  detail: string;
}

/**
 * Sources behind the merchant records this deployment actually serves, read
 * from the manifests of the imported releases. Empty when no release has been
 * imported into this database (the caller then falls back to the code-declared
 * allowlist and says so).
 */
function importedSources(db: Database): Source[] {
  const rows = db
    .prepare(
      `SELECT manifest_json FROM imports i
       WHERE id = (SELECT MAX(id) FROM imports WHERE city_key = i.city_key) ORDER BY city_key`,
    )
    .all() as { manifest_json: string }[];
  const seen = new Map<string, Source>();
  for (const row of rows) {
    let manifest: { sources?: Source[] };
    try {
      manifest = JSON.parse(row.manifest_json) as { sources?: Source[] };
    } catch {
      continue; // a malformed manifest must not blank the whole disclosure
    }
    for (const s of manifest.sources ?? []) {
      if (s?.source && !seen.has(s.source)) seen.set(s.source, { source: s.source, license: s.license, detail: s.detail });
    }
  }
  return [...seen.values()].sort((a, b) => a.source.localeCompare(b.source));
}

/** Every column of api_keys, in schema order — so a new column can't go undisclosed. */
function keyFields(db: Database): { column: string; note: string }[] {
  return (db.prepare("PRAGMA table_info(api_keys)").all() as { name: string }[]).map((c) => ({
    column: c.name,
    note: KEY_FIELD_NOTES[c.name] ?? "stored by the service; see the published schema for its meaning",
  }));
}

function renderPrivacy(db: Database, base: string, reviewed: boolean): string {
  const imported = importedSources(db);
  const declared: Source[] = Object.entries(SOURCE_LICENSES).map(([source, v]) => ({ source, ...v }));
  const sources = imported.length ? imported : declared;
  const sourceIntro = imported.length
    ? "These are the sources behind the merchant records this service currently serves, taken from the release manifests it imported:"
    : "No release has been imported into this deployment yet, so this is the set of sources the ingestion pipeline is licensed to use (declared in code); the served list appears here once a release is imported:";

  const humanCallLive = config.fulfillment.liveChannels.includes("human_call");
  const notifyOn = Boolean(config.operatorNotify.repo && config.operatorNotify.token);
  const region = process.env.FLY_REGION;
  const li = (s: string) => `<li>${s}</li>`;

  const fulfillmentPara = humanCallLive
    ? `Fulfillment is live: a human operator phones the merchant to place the reservation, so the merchant hears the reservation name, time and party size exactly as they would from any caller.`
    : `Real-merchant fulfillment is <strong>not live yet</strong> — <code>place_booking</code> against a real merchant returns <code>fulfillment_not_live</code>, so no reservation details reach any real merchant today. Sandbox bookings are simulated end-to-end and never dial anyone.`;

  const notifyPara = notifyOn
    ? `Operator notifications are <strong>enabled</strong> on this deployment: when a real booking needs a human call, the merchant name, address, phone, requested time, party size and your <code>special_requests</code> text are posted as an issue in a private repository on GitHub, which closes when the booking reaches a terminal state. The reservation name is deliberately excluded from that issue and stays in the authenticated console.`
    : `Operator notifications are <strong>not enabled</strong> on this deployment. When they are, a real booking needing a human call posts the merchant details, requested time, party size and your <code>special_requests</code> text as an issue in a private repository on GitHub — the reservation name is deliberately excluded and stays in the authenticated console.`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy — Mercantry</title>
<meta name="description" content="What the Mercantry registry stores, where merchant data comes from, and what happens to booking and API-key data.">
<link rel="canonical" href="${esc(base)}/privacy">
${reviewed ? "" : '<meta name="robots" content="noindex">\n'}<style>
  body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#1a1a1a;line-height:1.55}
  h1{margin-bottom:4px}
  h2{margin-top:32px;font-size:1.15em}
  code{font-size:.92em}
  table{border-collapse:collapse;width:100%;font-size:.92em}
  th,td{text-align:left;vertical-align:top;border-bottom:1px solid #ddd;padding:6px 8px}
  .draft{border-left:4px solid #e65100;padding:2px 16px;background:#fff8f2;border-radius:0 6px 6px 0}
  .meta,footer{color:#555;font-size:.92em}
  footer{border-top:1px solid #ddd;margin-top:32px;padding-top:12px}
  @media (prefers-color-scheme: dark){
    body{background:#111;color:#e8e8e8}
    .draft{background:#1d1712}
    th,td{border-color:#333}
    .meta,footer{color:#aaa}
    footer{border-color:#333}
    a{color:#8ab4f8}
  }
</style>
</head>
<body>
<h1>Privacy</h1>
<p><strong>${esc(CANONICAL)}</strong> This page states what data the service holds, where it comes from, and what happens to it. It is written for both humans and agents.</p>
${
  reviewed
    ? ""
    : `<div class="draft"><p><strong>Draft — pending legal review.</strong> This page describes the service accurately as built, but it has not yet been reviewed by counsel and is not offered as a final legal notice. It is marked <code>noindex</code> until that review completes.</p></div>\n`
}<p class="meta">Last updated: ${esc(POLICY_UPDATED)} · Contact: <a href="${ISSUES_URL}">${ISSUES_URL}</a></p>

<h2>What this service is</h2>
<p>Mercantry serves a registry of merchant records to AI agents over MCP and REST. Reads are free — anonymously, or with a self-serve API key. Booking fulfillment, where live, places a real reservation with a merchant on a caller's behalf. There is nothing to buy and no payment data is ever collected.</p>

<h2>Merchant data (the registry itself)</h2>
<p>${esc(sourceIntro)}</p>
<table>
<tr><th>Source</th><th>License</th></tr>
${sources
  .map(
    (s) =>
      `<tr><td><code>${esc(s.source)}</code><br><span class="meta">${esc(s.detail)}</span></td><td>${esc(s.license)}</td></tr>`,
  )
  .join("\n")}
</table>
<ul>
${li("Every field carries per-field provenance. The registry adds no scraped reviews, no scraped social content, and no data from platforms whose terms forbid it.")}
${li("Records may contain business contact details — a listed phone number, for instance — which can be personal data for a sole proprietor. Source data is served as the source publishes it; corrections come from direct phone contact with the merchant.")}
${li(`Merchant opt-out is immediate and permanent: ask via <a href="${ISSUES_URL}">${ISSUES_URL}</a> or tell the operator on any call. An opted-out record is retained but excluded from every read, search, export and booking path, and imports never re-list it.`)}
${li("Records are never deleted by an import — a merchant that disappears from a source keeps its row, so provenance stays auditable.")}
</ul>

<h2>Data about API users</h2>
<p>Keys are optional; reads work without one. Minting a key (<code>POST /v1/keys</code>) stores exactly these columns:</p>
<table>
<tr><th>Column</th><th>What it holds</th></tr>
${keyFields(db)
  .map((f) => `<tr><td><code>${esc(f.column)}</code></td><td>${esc(f.note)}</td></tr>`)
  .join("\n")}
</table>
<ul>
${li("<strong>No request log is written.</strong> The service runs no HTTP access logger: requests are not recorded per-caller, and read queries are not retained.")}
${li("Rate-limit counters live in memory only, keyed by API key or client IP, and expire within a minute of their window. They are never written to the database.")}
${li("Unhandled server errors are printed to the host's process log, which can include the request path and the error text.")}
${li("No cookies, no analytics, no third-party trackers, no advertising, and no sale or sharing of user data. Keys exist for rate limiting and abuse control, not profiling.")}
</ul>

<h2>Booking data</h2>
<p>A booking row stores what fulfillment needs: the merchant, requested time and window, party size, the reservation name, an optional contact for confirmation relay, optional special requests, an optional <code>callback_url</code>, an optional <code>client_reference_id</code> you supply, and the key the booking was made with. Every state transition is timestamped in an append-only event log, and call attempts store the operator, the disposition and the call's transcript lines.</p>
<ul>
${li("Reservation names and contacts are used only to place and follow up that booking. They are never exposed through any read tool, never included in search results, and never part of any export or dataset release.")}
${li(fulfillmentPara)}
${li("<strong>Calls are not recorded.</strong> The service captures no audio anywhere. Transcript rows hold text lines — today only from simulated sandbox calls — and human calls record a disposition and the operator's notes.")}
${li("If you supply a <code>callback_url</code>, booking state changes are sent to that URL — you choose that recipient.")}
${li(notifyPara)}
${li("Feedback is accepted only against a confirmed booking, once, within 14 days, and concerns the transaction rather than any individual.")}
${li("Retention: booking rows, their event log and issued keys are kept indefinitely — the service runs no automatic deletion job, so the honest statement is that nothing expires on its own. Deletion on request is covered below.")}
</ul>

<h2>Sharing, and where this runs</h2>
<ul>
${li("Bulk export of merchant records is a feature, not a leak: the corpus is openly licensed and downloadable by design (<code>/v1/export/merchants.ndjson</code>). Key data and booking data are never part of any export or dataset release.")}
${li(`Infrastructure: the service runs on Fly.io${region ? ` (region <code>${esc(region)}</code>)` : ""}; source code and the issue tracker are on GitHub. Outbound data flows are only the ones named above: your own <code>callback_url</code>, and operator-notification issues when that is enabled.`)}
${li("The registry serves records from more than one jurisdiction, and its cross-border posture is part of a pending legal review. Nothing in the calling specification operates until that review completes; this page will be updated with the outcome rather than quietly revised.")}
</ul>

<h2>Your choices</h2>
<ul>
${li(`<strong>Merchants:</strong> opt out permanently, or ask for a correction, via <a href="${ISSUES_URL}">${ISSUES_URL}</a>. Opt-out is applied by end of business day and honored on every future import.`)}
${li(`<strong>API users:</strong> stop using a key and request its deletion via <a href="${ISSUES_URL}">${ISSUES_URL}</a>; deleting a key removes the contact details you supplied with it. Ask the same way for deletion of a booking's reservation name and contact.`)}
${li("<strong>Anyone:</strong> this policy's history is public in the repository — changes are visible as diffs, not silent edits.")}
</ul>

<p class="meta"><a href="/">Home</a> · <a href="/v1">API index</a> · <a href="/llms.txt">llms.txt</a> · <a href="/.well-known/mcp.json">MCP manifest</a> · <a href="${REPO_URL}">GitHub</a></p>
<footer>Mercantry — an open commerce registry for AI agents. Policy last updated ${esc(POLICY_UPDATED)} · schema ${esc(config.schemaVersion)}</footer>
</body>
</html>
`;
}

/** Fail-safe body if a render has never succeeded — the disclosure still says the essential things. */
const FALLBACK = `<!doctype html><meta charset="utf-8"><title>Privacy — Mercantry</title><h1>Privacy</h1><p>${CANONICAL}</p><p>Merchant records come from openly licensed public sources with per-field provenance. Optional API keys store the name and contact you supply plus the minting IP; no request log is written; no cookies or trackers. Booking data (reservation name, contact) is used only to place that booking and is never exported or served through any read tool. Merchant opt-out and data deletion: <a href="${ISSUES_URL}">${ISSUES_URL}</a>.</p>`;

/** Base URL for absolute links: PUBLIC_BASE_URL env wins, else derived per-request. */
function baseUrl(req: express.Request): string {
  if (config.publicBaseUrl) return config.publicBaseUrl.replace(/\/$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

export function privacyRouter(db: Database, opts: { reviewed?: boolean } = {}): express.Router {
  const reviewed = opts.reviewed ?? config.privacyPolicyReviewed;
  const router = express.Router();
  // Last-good cache (60s TTL), same never-500 guarantee as / and /llms.txt.
  let cache: { body: string; base: string; at: number } | undefined;
  router.get("/privacy", (req, res) => {
    const base = baseUrl(req);
    const nowMs = Date.now();
    if (!cache || cache.base !== base || nowMs - cache.at > CACHE_TTL_MS) {
      try {
        cache = { body: renderPrivacy(db, base, reviewed), base, at: nowMs };
      } catch (e) {
        console.error("privacy render failed; serving fallback:", e);
        cache = { body: cache?.body ?? FALLBACK, base, at: nowMs };
      }
    }
    res.type("html").send(cache.body);
  });
  return router;
}
