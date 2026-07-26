import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { privacyRouter, POLICY_UPDATED } from "../src/api/privacy.js";
import { discoveryRouter } from "../src/api/discovery.js";
import { landingRouter } from "../src/api/landing.js";
import { v1Index } from "../src/api/openapi.js";
import { testDb, insertMerchant } from "./helpers.js";

/** Boot a router on an ephemeral port and hand back its base URL. */
function serve(router: express.Router): () => string {
  const app = express();
  app.use(router);
  const server = app.listen(0);
  servers.push(server);
  return () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const servers: ReturnType<express.Express["listen"]>[] = [];
after(() => servers.forEach((s) => s.close()));

// Default deployment state: no release imported, policy not yet human-reviewed.
const db = testDb();
insertMerchant(db);
const base = serve(privacyRouter(db));

test("GET /privacy serves the policy with contact, last-updated, and the canonical sentence", async () => {
  const res = await fetch(`${base()}/privacy`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  const html = await res.text();
  assert.match(html, /Mercantry is an open commerce registry for AI agents/);
  assert.match(html, new RegExp(`Last updated: ${POLICY_UPDATED}`));
  assert.match(html, /github\.com\/mercantry\/registry\/issues/);
  // The sections a directory reviewer looks for.
  for (const heading of ["Merchant data", "Data about API users", "Booking data", "Your choices"])
    assert.match(html, new RegExp(heading), `missing section: ${heading}`);
});

test("unreviewed policy carries the draft banner and noindex; the reviewed one carries neither", async () => {
  const draft = await (await fetch(`${base()}/privacy`)).text();
  assert.match(draft, /Draft — pending legal review/);
  assert.match(draft, /<meta name="robots" content="noindex">/);

  const reviewedBase = serve(privacyRouter(db, { reviewed: true }));
  const reviewed = await (await fetch(`${reviewedBase()}/privacy`)).text();
  assert.doesNotMatch(reviewed, /Draft — pending legal review/);
  assert.doesNotMatch(reviewed, /noindex/);
  // Facts are identical either way — the flag governs presentation, not disclosure.
  assert.match(reviewed, /No request log is written/);
  assert.match(reviewed, /Calls are not recorded/);
});

test("every api_keys column is disclosed — including one the policy has never heard of", async () => {
  const disclosureDb = testDb();
  disclosureDb.exec("ALTER TABLE api_keys ADD COLUMN referral_source TEXT");
  const disclosureBase = serve(privacyRouter(disclosureDb));
  const html = await (await fetch(`${disclosureBase()}/privacy`)).text();

  const columns = (disclosureDb.prepare("PRAGMA table_info(api_keys)").all() as { name: string }[]).map((c) => c.name);
  assert.ok(columns.includes("referral_source"));
  for (const column of columns) assert.match(html, new RegExp(`<code>${column}</code>`), `undisclosed column: ${column}`);
  // The unknown column still gets a truthful placeholder rather than being dropped.
  assert.match(html, /referral_source<\/code><\/td><td>stored by the service/);
  // The two most easily under-claimed facts must be stated outright.
  assert.match(html, /stored as issued/); // api_key is not hashed
  assert.match(html, /IP address the mint request came from/);
});

test("booking columns holding caller-supplied personal data are all named in the policy", async () => {
  // Tripwire: if the bookings table grows a column that holds something a
  // caller supplied, this fails until the policy text accounts for it.
  const known = new Set([
    "booking_id", "merchant_id", "api_key_id", "state", "failure_reason", "party_size", "requested_time",
    "window_minutes", "accept_within_window", "confirmed_time", "reservation_name", "contact", "special_requests",
    "callback_url", "needs_input_options", "needs_input_deadline", "merchant_instructions", "confirmation_code",
    "attempts", "next_attempt_at", "sla_deadline", "notify_issue_number", "notify_issue_closed",
    "client_reference_id", "request_fingerprint", "sandbox_outcome", "created_at", "updated_at",
  ]);
  const actual = (db.prepare("PRAGMA table_info(bookings)").all() as { name: string }[]).map((c) => c.name);
  const added = actual.filter((c) => !known.has(c));
  assert.deepEqual(added, [], `new bookings column(s) ${added.join(", ")} — check /privacy discloses them, then update this list`);

  const html = await (await fetch(`${base()}/privacy`)).text();
  for (const phrase of ["reservation name", "special requests", "callback_url", "client_reference_id", "sandbox_outcome"])
    assert.match(html, new RegExp(phrase), `booking field not described: ${phrase}`);
});

test("source list falls back to the licensed allowlist when nothing has been imported", async () => {
  const html = await (await fetch(`${base()}/privacy`)).text();
  assert.match(html, /No release has been imported into this deployment yet/);
  assert.match(html, /<code>overture<\/code>/);
  assert.match(html, /CDLA-Permissive-2\.0/);
});

test("once a release is imported, the served source list comes from its manifest and is escaped", async () => {
  const importedDb = testDb();
  insertMerchant(importedDb, { sandbox: 0, city: "Hong Kong" });
  const manifest = {
    sources: [
      { source: "fehd_hk", license: "data.gov.hk Terms of Use", detail: "HK FEHD licensed restaurants" },
      // Manifests are generated data — a hostile value must render inert.
      { source: "x<script>alert(1)</script>", license: "CC0-1.0", detail: "hostile" },
    ],
  };
  importedDb
    .prepare(
      `INSERT INTO imports (city_key, city, release, generated_at, imported_at, checksum_sha256,
        merchant_count, inserted, updated, unchanged, phone_conflicts, manifest_json)
       VALUES ('hk','Hong Kong','2026-07-22-hk','2026-07-22',?,'abc',1,1,0,0,0,?)`,
    )
    .run(new Date().toISOString(), JSON.stringify(manifest));
  // A malformed manifest must not blank out the whole disclosure.
  importedDb
    .prepare(
      `INSERT INTO imports (city_key, city, release, generated_at, imported_at, checksum_sha256,
        merchant_count, inserted, updated, unchanged, phone_conflicts, manifest_json)
       VALUES ('la','Los Angeles','2026-07-22-la','2026-07-22',?,'def',1,1,0,0,0,'{not json')`,
    )
    .run(new Date().toISOString());

  const html = await (await fetch(`${serve(privacyRouter(importedDb))()}/privacy`)).text();
  assert.match(html, /sources behind the merchant records this service currently serves/);
  assert.match(html, /<code>fehd_hk<\/code>/);
  assert.doesNotMatch(html, /No release has been imported/);
  assert.ok(!html.includes("<script>alert(1)</script>"), "manifest values must be HTML-escaped");
});

test("never 500s: a broken render still serves the essential disclosure", async () => {
  const brokenDb = testDb();
  brokenDb.exec("DROP TABLE imports");
  const html = await (await fetch(`${serve(privacyRouter(brokenDb))()}/privacy`)).text();
  assert.match(html, /Merchant records come from openly licensed public sources/);
  assert.match(html, /github\.com\/mercantry\/registry\/issues/);
});

test("the policy URL is discoverable from every surface that advertises the service", async () => {
  const discoveryBase = serve(discoveryRouter(db));
  const manifest = (await (await fetch(`${discoveryBase()}/.well-known/mcp.json`)).json()) as Record<string, any>;
  assert.match(manifest.privacy_policy, /\/privacy$/);
  assert.match(manifest.data_policy.privacy_policy, /\/privacy$/);

  const robots = await (await fetch(`${discoveryBase()}/robots.txt`)).text();
  assert.match(robots, /Privacy policy: http:\/\/[^\s]+\/privacy/);
  assert.doesNotMatch(robots, /Disallow: \/privacy/);

  const landing = await (await fetch(`${serve(landingRouter(db))()}/`)).text();
  assert.match(landing, /<a href="\/privacy">Privacy<\/a>/);

  assert.equal(v1Index("https://example.test").endpoints.privacy_policy, "https://example.test/privacy");
});
