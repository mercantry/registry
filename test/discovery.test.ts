import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { discoveryRouter } from "../src/api/discovery.js";
import { testDb, insertMerchant } from "./helpers.js";

const db = testDb();
insertMerchant(db);

const app = express();
app.use(discoveryRouter(db));
const server = app.listen(0);
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(() => server.close());

test("/.well-known/mcp.json is a crawlable manifest pointing at the MCP endpoint", async () => {
  const res = await fetch(`${base()}/.well-known/mcp.json`);
  assert.equal(res.status, 200);
  const m = await res.json();
  assert.equal(m.name, "registry");
  assert.equal(m.mcp.transport, "streamable-http");
  assert.ok(m.mcp.endpoint.endsWith("/mcp"));
  assert.equal(m.mcp.tools.length, 9);
  assert.match(m.data_policy.ranking, /none/);
  // Honesty rule: pre-launch data must be labeled synthetic, never passed off as real.
  assert.match(m.data_policy.current_data_status, /synthetic/);
  assert.equal(m.coverage.merchant_count, 1);
});

test("/healthz reports ok with a live database", async () => {
  const res = await fetch(`${base()}/healthz`);
  assert.equal(res.status, 200);
  const h = await res.json();
  assert.equal(h.ok, true);
  assert.equal(h.merchants, 1);
});
