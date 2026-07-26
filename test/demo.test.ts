/**
 * /demo — the standing demo & reviewer guide.
 *
 * The property that matters: every merchant id the page publishes is one this
 * deployment can actually book right now. A stale fixture would send a
 * reviewer straight into a structured rejection and read as a broken
 * connector, so the ids are read live and re-checked here against the same
 * booking path an agent would use.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { demoRouter } from "../src/api/demo.js";
import { landingRouter } from "../src/api/landing.js";
import { discoveryRouter } from "../src/api/discovery.js";
import { v1Index } from "../src/api/openapi.js";
import { placeBooking } from "../src/orchestrator/bookings.js";
import { SANDBOX_OUTCOMES } from "../src/registry/types.js";
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

const db = testDb();
const sandboxIds = [insertMerchant(db, { name: "Sandbox Uno" }), insertMerchant(db, { name: "Sandbox Dos" })];
// Noise the page must not publish: a real merchant, an opted-out one, and an
// unbookable one — none of them can complete a booking today.
const realId = insertMerchant(db, { sandbox: 0, name: "Real Merchant", city: "Hong Kong" });
const optedOutId = insertMerchant(db, { opt_out: 1, name: "Opted Out" });
const walkInId = insertMerchant(db, { reservation_policy: "walk_in_only", name: "Walk In Only" });
const base = serve(demoRouter(db));

const page = () => fetch(`${base()}/demo`).then((r) => r.text());

test("GET /demo serves the guide with the sections a reviewer needs", async () => {
  const res = await fetch(`${base()}/demo`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  const html = await res.text();
  assert.match(html, /Mercantry is an open commerce registry for AI agents/);
  for (const heading of ["Credentials", "Connect", "Sample data", "walkthrough", "Forced outcomes", "What is real"])
    assert.match(html, new RegExp(heading), `missing section: ${heading}`);
  // The access model is stated rather than implied: no account to hand over.
  assert.match(html, /Reads and sandbox bookings are open/);
  assert.match(html, /POST \/v1\/keys|\/v1\/keys/);
  // Connect line + both transports.
  assert.match(html, /claude mcp add --transport http mercantry/);
  assert.match(html, /\/mcp<\/code>/);
});

test("every published merchant id is bookable right now", async () => {
  const html = await page();
  const published = [...html.matchAll(/<td><code>([0-9a-f-]{36})<\/code><\/td>/g)].map((m) => m[1]);
  assert.ok(published.length > 0, "no sample merchants published");
  for (const id of published) {
    // The real proof: run the id through the booking path a reviewer would.
    const res = placeBooking(db, {
      merchant_id: id,
      party_size: 2,
      datetime: "2026-07-18T19:00",
      reservation_name: "Reviewer",
      sandbox_outcome: "confirmed",
    });
    assert.ok(res.ok, `published merchant ${id} is not bookable: ${res.error}`);
  }
  for (const id of published) assert.ok(sandboxIds.includes(id), `unexpected id published: ${id}`);
});

test("real, opted-out and unbookable merchants never appear as samples", async () => {
  const html = await page();
  for (const [label, id] of [["real", realId], ["opted-out", optedOutId], ["walk-in", walkInId]] as const)
    assert.doesNotMatch(html, new RegExp(id), `${label} merchant published as a demo target`);
  assert.doesNotMatch(html, /Real Merchant|Opted Out|Walk In Only/);
});

test("the forced-outcome contract is documented for every accepted value", async () => {
  const html = await page();
  for (const outcome of SANDBOX_OUTCOMES)
    assert.match(html, new RegExp(`<code>${outcome}</code>`), `outcome not documented: ${outcome}`);
  // The sandbox-only rule and the error a caller gets for breaking it.
  assert.match(html, /sandbox_outcome_requires_sandbox_merchant/);
  // The suggested datetime is a merchant-local wall clock, not a UTC instant.
  assert.match(html, /"datetime": "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}"/);
});

test("the page says what is NOT live, in the state this deployment is actually in", async () => {
  const html = await page();
  assert.match(html, /fulfillment is <strong>not live<\/strong>/);
  assert.match(html, /fulfillment_not_live/);
  assert.match(html, /availability is checked on the call/);
  // Coverage tracks the live DB: this fixture serves exactly one real merchant,
  // and the sandbox records are excluded from that count.
  assert.match(html, /real, QA-gated corpus of <strong>1<\/strong> merchants/);
});

test("a deployment with no bookable sandbox merchant says so instead of publishing a dead id", async () => {
  const emptyDb = testDb();
  insertMerchant(emptyDb, { sandbox: 0 }); // real merchants only
  const emptyBase = serve(demoRouter(emptyDb));
  const html = await (await fetch(`${emptyBase()}/demo`)).text();
  assert.match(html, /no bookable sandbox merchant/);
  assert.doesNotMatch(html, /<td><code>[0-9a-f-]{36}<\/code><\/td>/);
});

test("the page never 500s, even with the merchants table gone", async () => {
  const brokenDb = testDb();
  const brokenBase = serve(demoRouter(brokenDb));
  brokenDb.exec("DROP TABLE provenance; DROP TABLE verification_calls; DROP TABLE bookings; DROP TABLE merchants");
  const res = await fetch(`${brokenBase()}/demo`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Demo/);
  assert.match(html, /sandbox_outcome/);
});

test("the demo is reachable from the surfaces agents actually crawl", async () => {
  const landing = await (await fetch(`${serve(landingRouter(db))()}/`)).text();
  assert.match(landing, /href="\/demo"/);

  const discovery = serve(discoveryRouter(db));
  const manifest = await (await fetch(`${discovery()}/.well-known/mcp.json`)).json();
  assert.match(manifest.demo, /\/demo$/);

  const card = await (await fetch(`${discovery()}/.well-known/agent-card.json`)).json();
  const booking = card.skills.find((s: { id: string }) => s.id === "booking");
  assert.match(booking.description, /\/demo/);

  const llms = await (await fetch(`${discovery()}/llms.txt`)).text();
  assert.match(llms, /\/demo/);

  assert.match(v1Index("https://example.test").endpoints.demo, /\/demo$/);
});
