import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { discoveryRouter } from "../src/api/discovery.js";
import { testDb, insertMerchant } from "./helpers.js";

// App 1: sandbox-only registry (dev-preview state).
const db = testDb();
insertMerchant(db);

const app = express();
app.use(discoveryRouter(db));
const server = app.listen(0);
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// App 2: real corpus imported (post-cutover state) — separate instance so the
// llms.txt render cache and DB state can't bleed between the two scenarios.
const realDb = testDb();
insertMerchant(realDb); // sandbox seed merchant (SF) — must NOT appear in public coverage
insertMerchant(realDb, { sandbox: 0, city: "Hong Kong", name: "Kowloon Noodle House" });
insertMerchant(realDb, { sandbox: 0, city: "Hong Kong", name: "Wan Chai Congee" });
insertMerchant(realDb, { sandbox: 0, city: "Tokyo", name: "Shinjuku Soba" });
insertMerchant(realDb, { sandbox: 0, city: "Tokyo", name: "Opted Out", opt_out: 1 });

const realApp = express();
realApp.use(discoveryRouter(realDb));
const realServer = realApp.listen(0);
const realBase = () => `http://127.0.0.1:${(realServer.address() as AddressInfo).port}`;

after(() => {
  server.close();
  realServer.close();
});

test("/.well-known/mcp.json is a crawlable manifest pointing at the MCP endpoint", async () => {
  const res = await fetch(`${base()}/.well-known/mcp.json`);
  assert.equal(res.status, 200);
  const m = await res.json();
  assert.equal(m.name, "registry");
  assert.equal(m.mcp.transport, "streamable-http");
  assert.ok(m.mcp.endpoint.endsWith("/mcp"));
  assert.equal(m.mcp.tools.length, 9);
  assert.match(m.data_policy.ranking, /none/);
  // Honesty rule: pre-cutover data must be labeled synthetic/sandbox, never passed off as real.
  assert.match(m.data_policy.current_data_status, /synthetic/);
  assert.equal(m.coverage.merchant_count, 1);
  assert.equal(m.coverage.real_count, 0);
  assert.deepEqual(m.coverage.cities, []); // sandbox merchants never claim a public city
});

test("mcp.json reports the real corpus honestly once real merchants are served", async () => {
  const res = await fetch(`${realBase()}/.well-known/mcp.json`);
  const m = await res.json();
  assert.match(m.data_policy.current_data_status, /real merchant corpus live/);
  assert.match(m.data_policy.current_data_status, /discovery-only/);
  // Coverage derives from the live DB: real cities only, opted-out + sandbox excluded.
  assert.deepEqual(m.coverage.cities, [
    { city: "Hong Kong", merchant_count: 2 },
    { city: "Tokyo", merchant_count: 1 },
  ]);
  assert.equal(m.coverage.real_count, 4); // opted-out merchants still exist, just not served
  assert.equal(m.coverage.sandbox_count, 1);
});

test("/llms.txt renders the template with live per-city stats", async () => {
  const res = await fetch(`${realBase()}/llms.txt`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
  const body = await res.text();
  assert.ok(!body.includes("{{"), "all template markers must be replaced");
  assert.ok(!body.includes("Template note"), "the eng template note is stripped from the served copy");
  assert.match(body, /2 cities \(Hong Kong 2 · Tokyo 1\)/);
  assert.match(body, /3 merchants across 2 cities/); // opted-out excluded from the served count
  assert.ok(!body.includes("San Francisco"), "sandbox seed city never enters public copy");
  assert.match(body, /Generated: \d{4}-\d{2}-\d{2}T/);
  assert.match(body, /schema_version 1\.0\.0/);
  // Relative doc links are rewritten to resolvable repo URLs.
  assert.match(body, /https:\/\/github\.com\/[^)]+\/blob\/main\/docs\/faq\.md/);
});

test("/llms.txt on a sandbox-only registry says so instead of claiming coverage", async () => {
  const res = await fetch(`${base()}/llms.txt`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /0 cities \(sandbox-only preview/);
});

test("/robots.txt welcomes AI crawlers and shields ops + status pages", async () => {
  const res = await fetch(`${realBase()}/robots.txt`);
  assert.equal(res.status, 200);
  const body = await res.text();
  for (const bot of ["GPTBot", "ClaudeBot", "PerplexityBot", "CCBot", "Googlebot", "Bingbot"]) {
    assert.ok(body.includes(`User-agent: ${bot}`), `${bot} explicitly welcomed`);
  }
  assert.match(body, /Allow: \//);
  assert.match(body, /Disallow: \/ops\//);
  assert.match(body, /Disallow: \/status\//); // reservation names live there — not for crawlers
  assert.match(body, /llms\.txt/);
});

test("/healthz reports ok with a live database", async () => {
  const res = await fetch(`${base()}/healthz`);
  assert.equal(res.status, 200);
  const h = await res.json();
  assert.equal(h.ok, true);
  assert.equal(h.merchants, 1);
});
