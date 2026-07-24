import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { landingRouter } from "../src/api/landing.js";
import { testDb, insertMerchant } from "./helpers.js";

// App 1: sandbox-only registry (dev-preview state).
const db = testDb();
insertMerchant(db);

const app = express();
app.use(landingRouter(db));
const server = app.listen(0);
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// App 2: real corpus imported (post-cutover state) — separate instance so the
// render cache and DB state can't bleed between the two scenarios.
const realDb = testDb();
insertMerchant(realDb); // sandbox seed merchant (SF) — must NOT appear in public coverage
insertMerchant(realDb, { sandbox: 0, city: "Hong Kong", name: "Kowloon Noodle House" });
insertMerchant(realDb, { sandbox: 0, city: "Hong Kong", name: "Wan Chai Congee" });
insertMerchant(realDb, { sandbox: 0, city: "Tokyo", name: "Shinjuku Soba" });
insertMerchant(realDb, { sandbox: 0, city: "Tokyo", name: "Opted Out", opt_out: 1 });
// City names come from external sources — a hostile value must render inert.
insertMerchant(realDb, { sandbox: 0, city: 'X<script>alert("x")</script>', name: "Escapee" });

const realApp = express();
realApp.use(landingRouter(realDb));
const realServer = realApp.listen(0);
const realBase = () => `http://127.0.0.1:${(realServer.address() as AddressInfo).port}`;

after(() => {
  server.close();
  realServer.close();
});

const extractJsonLd = (html: string) => {
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(m, "landing page must embed a JSON-LD block");
  return JSON.parse(m![1]);
};

test("GET / serves the landing page with the canonical sentence and connect snippets", async () => {
  const res = await fetch(`${base()}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  const html = await res.text();
  assert.match(html, /Mercantry is an open commerce registry for AI agents/);
  assert.match(html, /claude mcp add --transport http mercantry/);
  assert.match(html, /\/v1\/merchants\?bookable_only=false/);
  // Machine surfaces are linked, not orphaned.
  assert.match(html, /href="\/llms\.txt"/);
  assert.match(html, /href="\/v1\/openapi\.json"/);
  assert.match(html, /href="\/\.well-known\/mcp\.json"/);
  assert.match(html, /github\.com\/mercantry\/registry/);
});

test("honesty: sandbox-only state never claims a real corpus or a live channel", async () => {
  const html = await (await fetch(`${base()}/`)).text();
  assert.match(html, /Sandbox-only preview — no real corpus imported/);
  assert.match(html, /synthetic demo data/);
  assert.doesNotMatch(html, /real, QA-gated corpus/);
  // human_call is not in liveChannels: the page must say fulfillment isn't live.
  assert.match(html, /fulfillment_not_live/);
  // Sandbox merchants never claim a public city (the seed merchant is SF).
  assert.doesNotMatch(html, /San Francisco/);
});

test("real corpus state: live DB-derived coverage, alphabetical, opt-out excluded", async () => {
  const html = await (await fetch(`${realBase()}/`)).text();
  // 2 HK + 1 Tokyo + 1 hostile-city = 4 real served merchants (opt-out + sandbox excluded).
  assert.match(html, /<strong>4<\/strong> merchants across/);
  assert.match(html, /real, QA-gated corpus/);
  assert.doesNotMatch(html, /Sandbox-only preview/);
  assert.doesNotMatch(html, /San Francisco/); // sandbox city never leaks into coverage
  assert.ok(html.indexOf("Hong Kong") < html.indexOf("Tokyo"), "cities listed alphabetically");
});

test("city names are HTML-escaped and JSON-LD stays parseable", async () => {
  const html = await (await fetch(`${realBase()}/`)).text();
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /X&lt;script&gt;/);
  const ld = extractJsonLd(html);
  const types = ld["@graph"].map((n: any) => n["@type"]);
  assert.deepEqual(types, ["Organization", "WebAPI", "Dataset"]);
  assert.equal(ld["@graph"][0].name, "Mercantry");
  assert.match(ld["@graph"][2].distribution.contentUrl, /\/v1\/export\/merchants\.ndjson$/);
});

test("sandbox-only state publishes no Dataset node (nothing real to cite yet)", async () => {
  const html = await (await fetch(`${base()}/`)).text();
  const types = extractJsonLd(html)["@graph"].map((n: any) => n["@type"]);
  assert.deepEqual(types, ["Organization", "WebAPI"]);
});

test("the page never ranks: no ranking vocabulary beyond the denial", async () => {
  const html = await (await fetch(`${realBase()}/`)).text();
  assert.match(html, /No ranking exists in the schema/);
  assert.doesNotMatch(html, /top-rated|best restaurants|recommended/i);
});
