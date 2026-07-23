/**
 * Gate B (note 002) — endpoint hardening tests:
 *  - self-serve key minting is bounded per IP per day, with input validation
 *  - per-IP identification works behind a Fly-style proxy (TRUST_PROXY=1):
 *    the client IP is the rightmost X-Forwarded-For entry (appended by the
 *    edge), so spoofed entries a client prepends are ignored
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { keysRouter, mintAllowed } from "../src/api/keys.js";
import { config } from "../src/config.js";
import { testDb } from "./helpers.js";

const db = testDb();

// Mirror production topology: Express behind one trusted proxy hop.
const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use("/v1/keys", keysRouter(db));
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/keys`;

after(() => server.close());

// The test client plays the Fly edge: it appends the "real" client IP as the
// rightmost X-Forwarded-For entry (anything left of it is client-supplied).
async function mint(xff: string, body: Record<string, unknown> = {}) {
  const res = await fetch(base(), {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": xff },
    body: JSON.stringify({ developer_name: "Test Dev", contact: "dev@example.com", ...body }),
  });
  return { status: res.status, body: await res.json() };
}

test("input validation: name/contact required, webhook must be http(s)", async () => {
  assert.equal((await mint("10.0.0.1", { developer_name: "" })).status, 400);
  assert.equal((await mint("10.0.0.1", { developer_name: "x".repeat(81) })).status, 400);
  assert.equal((await mint("10.0.0.1", { contact: "" })).status, 400);
  assert.equal((await mint("10.0.0.1", { webhook_url: "ftp://nope" })).status, 400);
  assert.equal((await mint("10.0.0.1", { webhook_url: "not a url" })).status, 400);
});

test("minting is capped per client IP per day; other IPs unaffected", async () => {
  for (let i = 0; i < config.mcp.keysPerIpPerDay; i++) {
    const r = await mint("203.0.113.7");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.api_key, /^reg_/);
  }
  const blocked = await mint("203.0.113.7");
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, "key_minting_limit_per_ip");

  const other = await mint("203.0.113.8");
  assert.equal(other.status, 200);
});

test("spoofed XFF entries do not evade the per-IP cap behind trust proxy=1", async () => {
  // Client prepends junk; the edge appends the real IP (rightmost). All three
  // requests come from the same real client and must share one bucket.
  const real = "198.51.100.42";
  for (const junk of ["1.1.1.1", "2.2.2.2", "3.3.3.3"]) {
    const r = await mint(`${junk}, ${real}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const blocked = await mint(`9.9.9.9, ${real}`);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, "key_minting_limit_per_ip");
});

test("mintAllowed enforces the global daily backstop", () => {
  const isolated = testDb();
  const insert = isolated.prepare(
    "INSERT INTO api_keys (key_id, api_key, developer_name, contact, created_ip, created_at) VALUES (?,?,?,?,?,?)",
  );
  for (let i = 0; i < config.mcp.keysPerDayGlobal; i++) {
    insert.run(`k${i}`, `reg_${i}`, "d", "c", `10.1.${Math.floor(i / 250)}.${i % 250}`, new Date().toISOString());
  }
  const res = mintAllowed(isolated, "10.99.99.99");
  assert.equal(res.ok, false);
  assert.equal(res.error, "key_minting_limit_global");
});

test("old keys outside the 24h window do not count against the cap", () => {
  const isolated = testDb();
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const insert = isolated.prepare(
    "INSERT INTO api_keys (key_id, api_key, developer_name, contact, created_ip, created_at) VALUES (?,?,?,?,?,?)",
  );
  for (let i = 0; i < 10; i++) insert.run(`old${i}`, `reg_old${i}`, "d", "c", "203.0.113.50", twoDaysAgo);
  assert.equal(mintAllowed(isolated, "203.0.113.50").ok, true);
});
