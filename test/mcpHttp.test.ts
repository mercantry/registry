import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { mcpRouter } from "../src/mcp/http.js";
import { testDb, insertMerchant } from "./helpers.js";

const db = testDb();
const merchantId = insertMerchant(db, { name: "HTTP Test Bistro", neighborhood: "Mission" });

const app = express();
app.use(express.json());
app.use("/mcp", mcpRouter(db));
const server = app.listen(0);
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;

after(() => server.close());

async function rpc(body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test("initialize handshake works statelessly over HTTP", async () => {
  const { status, body } = await rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test-agent", version: "0.0.0" } },
  });
  assert.equal(status, 200);
  assert.equal(body.result.serverInfo.name, "registry");
});

test("tools/list exposes the full §6.2 tool surface", async () => {
  const { status, body } = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(status, 200);
  const names = body.result.tools.map((t: { name: string }) => t.name).sort();
  assert.deepEqual(names, [
    "cancel_booking",
    "get_availability",
    "get_booking_status",
    "get_merchant",
    "get_registry_meta",
    "modify_booking",
    "place_booking",
    "search_merchants",
    "submit_feedback",
  ]);
});

test("tools/call search_merchants returns registry data", async () => {
  const { status, body } = await rpc({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "search_merchants", arguments: { neighborhood: "Mission" } },
  });
  assert.equal(status, 200);
  const payload = JSON.parse(body.result.content[0].text);
  assert.equal(payload.total, 1);
  assert.equal(payload.results[0].merchant_id, merchantId);
});

test("invalid API key is rejected with 401; no key is fine", async () => {
  const bad = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/list" }, { "x-api-key": "reg_not_a_real_key" });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error.message, "invalid_api_key");

  const anon = await rpc({ jsonrpc: "2.0", id: 5, method: "tools/list" });
  assert.equal(anon.status, 200);
});

test("GET is 405 — stateless endpoint, POST only", async () => {
  const res = await fetch(base(), { headers: { accept: "text/event-stream" } });
  assert.equal(res.status, 405);
});
