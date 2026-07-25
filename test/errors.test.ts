/**
 * Agent-actionable error contract (registry/errors.ts + api/httpErrors.ts +
 * api/rateLimit.ts). Agents self-correct from error payloads alone, so the
 * contract is load-bearing:
 *  - stable machine codes (never interpolated), with field/allowed/example/message
 *  - REST statuses from the catalog; unknown /v1 paths and thrown errors stay JSON
 *  - 429s teach backoff: Retry-After header + retry_after_s in the body
 *  - MCP error results set isError and carry the same object + docs pointer
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { agentError, statusFor, docsUrl, DOCS_PATH } from "../src/registry/errors.js";
import { jsonErrorHandler, sendError, v1NotFound } from "../src/api/httpErrors.js";
import { makeRateLimit } from "../src/api/rateLimit.js";
import { keysRouter, mintAllowed } from "../src/api/keys.js";
import { mcpRouter } from "../src/mcp/http.js";
import { placeBooking, modifyBooking, cancelBooking, resolveFromCall } from "../src/orchestrator/bookings.js";
import { transition } from "../src/orchestrator/stateMachine.js";
import { submitFeedback } from "../src/feedback/feedback.js";
import { testDb, insertMerchant } from "./helpers.js";

const db = testDb();
const merchantId = insertMerchant(db, { name: "Contract Cafe", max_party_size: 8 });

/* One mini app exercising every REST-side piece the way server.ts wires it. */
const app = express();
app.use(express.json());
// Limiter on its own mount (tiny limit so the 429 path is testable) — a shared
// bucket would starve the other /v1 tests below.
app.use("/limited", makeRateLimit(db, 5));
app.get("/limited/ping", (_req, res) => res.json({ ok: true }));
app.get("/v1/boom", () => {
  throw new Error("kaboom");
});
app.post("/v1/echo-error", (req, res) => sendError(req, res, agentError(req.body.code)));
app.use("/v1/keys", keysRouter(db));
app.use("/v1", v1NotFound);
app.use("/mcp", mcpRouter(db));
app.use(jsonErrorHandler);
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(() => server.close());

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${base()}${path}`, init);
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
}

/* ---------------- catalog + helpers ---------------- */

test("agentError fills catalog defaults; overrides win; codes are stable (no interpolation)", () => {
  const e = agentError("party_size_out_of_range", { allowed: "1-8" });
  assert.equal(e.ok, false);
  assert.equal(e.error, "party_size_out_of_range"); // exact code, no parenthesized suffix
  assert.equal(e.field, "party_size");
  assert.equal(e.allowed, "1-8");
  assert.ok(e.message);
  const unknown = agentError("some_future_code");
  assert.equal(unknown.error, "some_future_code");
});

test("statusFor maps codes to REST statuses; unknown codes default to 400", () => {
  assert.equal(statusFor("unknown_merchant"), 404);
  assert.equal(statusFor("unknown_booking"), 404);
  assert.equal(statusFor("client_reference_conflict"), 409);
  assert.equal(statusFor("invalid_api_key"), 401);
  assert.equal(statusFor("rate_limited"), 429);
  assert.equal(statusFor("key_minting_limit_per_ip"), 429);
  assert.equal(statusFor("internal_error"), 500);
  assert.equal(statusFor("party_size_out_of_range"), 400);
  assert.equal(statusFor("never_heard_of_it"), 400);
  assert.equal(statusFor(undefined), 400);
});

test("docsUrl: absolute when a base is known, bare path otherwise", () => {
  assert.equal(docsUrl("https://example.test"), `https://example.test${DOCS_PATH}`);
  assert.equal(docsUrl("https://example.test/"), `https://example.test${DOCS_PATH}`);
  assert.equal(docsUrl(), DOCS_PATH); // no PUBLIC_BASE_URL in tests
});

/* ---------------- orchestrator errors are structured ---------------- */

test("place_booking errors carry field/allowed/message with stable codes", () => {
  const noSuch = placeBooking(db, {
    merchant_id: "00000000-0000-4000-8000-999999999999",
    party_size: 2,
    datetime: "2026-07-18T19:00",
    reservation_name: "A",
  });
  assert.equal(noSuch.error, "unknown_merchant");
  assert.equal(noSuch.field, "merchant_id");
  assert.ok(noSuch.message);

  const tooBig = placeBooking(db, {
    merchant_id: merchantId,
    party_size: 40,
    datetime: "2026-07-18T19:00",
    reservation_name: "A",
  });
  assert.equal(tooBig.error, "party_size_out_of_range"); // exact match — the old form appended " (max N)"
  assert.equal(tooBig.field, "party_size");
  assert.equal(tooBig.allowed, "1-8"); // the merchant's real range travels in `allowed`
  assert.match(tooBig.message!, /1-8/);

  const badTime = placeBooking(db, {
    merchant_id: merchantId,
    party_size: 2,
    datetime: "not-a-time",
    reservation_name: "A",
  });
  assert.equal(badTime.error, "invalid_datetime");
  assert.equal(badTime.field, "datetime");
  assert.ok(badTime.example);
});

test("modify/cancel errors: invalid_option_index carries the real range; terminal-state message names the state", () => {
  const booked = placeBooking(db, {
    merchant_id: merchantId,
    party_size: 2,
    datetime: "2026-07-18T19:00",
    reservation_name: "B",
  });
  transition(db, booked.booking_id!, "in_progress", {});
  resolveFromCall(db, booked.booking_id!, {
    kind: "needs_input",
    options: [{ time: "2026-07-18T19:30" }, { time: "2026-07-18T20:00" }],
  });
  const badIdx = modifyBooking(db, booked.booking_id!, { accept_option_index: 5 });
  assert.equal(badIdx.error, "invalid_option_index");
  assert.equal(badIdx.field, "accept_option_index");
  assert.equal(badIdx.allowed, "0-1");

  const cancelled = placeBooking(db, {
    merchant_id: merchantId,
    party_size: 2,
    datetime: "2026-07-18T19:00",
    reservation_name: "C",
  });
  cancelBooking(db, cancelled.booking_id!);
  const again = cancelBooking(db, cancelled.booking_id!);
  assert.equal(again.error, "booking_in_terminal_state"); // exact — no " (cancelled)" suffix
  assert.match(again.message!, /cancelled/);
  const modTerminal = modifyBooking(db, cancelled.booking_id!, { party_size: 3 });
  assert.equal(modTerminal.error, "booking_in_terminal_state");

  const feedback = submitFeedback(db, { booking_id: cancelled.booking_id!, reservation_honored: true });
  assert.equal(feedback.error, "feedback_requires_confirmed_booking");
  assert.equal(feedback.field, "booking_id");
});

/* ---------------- REST plumbing ---------------- */

test("sendError maps status from the catalog and attaches a request-derived docs URL", async () => {
  const conflict = await api("/v1/echo-error", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "client_reference_conflict" }),
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, "client_reference_conflict");
  assert.equal(conflict.body.docs, `${base()}${DOCS_PATH}`);

  const missing = await api("/v1/echo-error", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "unknown_booking" }),
  });
  assert.equal(missing.status, 404);
});

test("unknown /v1 paths return unknown_endpoint JSON, never HTML", async () => {
  const r = await api("/v1/no-such-thing");
  assert.equal(r.status, 404);
  assert.equal(r.body.error, "unknown_endpoint");
  assert.ok(r.body.docs.endsWith(DOCS_PATH));
});

test("malformed JSON body and thrown route errors both stay machine-readable", async () => {
  const bad = await api("/v1/echo-error", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "invalid_json_body");

  const boom = await api("/v1/boom");
  assert.equal(boom.status, 500);
  assert.equal(boom.body.error, "internal_error");
  assert.ok(boom.body.message);
});

test("429 teaches backoff: Retry-After header + structured body; X-RateLimit headers on every response", async () => {
  const first = await api("/limited/ping");
  assert.equal(first.headers.get("x-ratelimit-limit"), "5");
  assert.ok(Number(first.headers.get("x-ratelimit-remaining")) < 5);

  let limited: Awaited<ReturnType<typeof api>> | undefined;
  for (let i = 0; i < 6; i++) limited = await api("/limited/ping");
  assert.equal(limited!.status, 429);
  const retryAfter = Number(limited!.headers.get("retry-after"));
  assert.ok(retryAfter >= 1 && retryAfter <= 60, `retry-after ${retryAfter}`);
  assert.equal(limited!.body.error, "rate_limited");
  assert.equal(limited!.body.retry_after_s, retryAfter);
  assert.equal(limited!.body.limit, 5);
  assert.equal(limited!.body.remaining, 0);
  assert.ok(limited!.body.reset > Date.now() / 1000 - 1);
  assert.ok(limited!.body.docs.endsWith(DOCS_PATH));
});

/* ---------------- key minting ---------------- */

test("key validation errors use stable codes with field detail", async () => {
  const r = await api("/v1/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ developer_name: "", contact: "dev@example.com" }),
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "invalid_developer_name");
  assert.equal(r.body.field, "developer_name");
  assert.equal(r.body.allowed, "1-80 chars");
  assert.ok(r.body.docs.endsWith(DOCS_PATH));
});

test("minting caps return Retry-After scoped to the rolling 24h window", async () => {
  // Seed this client's IP to its cap directly; the oldest key is 12h old, so
  // the window frees up in ~12h — Retry-After must reflect that, not a flat 24h.
  const ip = "203.0.113.77";
  const twelveHoursAgo = new Date(Date.now() - 12 * 3600_000).toISOString();
  const recent = new Date().toISOString();
  const insert = db.prepare(
    "INSERT INTO api_keys (key_id, api_key, developer_name, contact, created_ip, created_at) VALUES (?,?,?,?,?,?)",
  );
  insert.run("k-old", "reg_test_old", "D", "d@example.com", ip, twelveHoursAgo);
  insert.run("k-new1", "reg_test_new1", "D", "d@example.com", ip, recent);
  insert.run("k-new2", "reg_test_new2", "D", "d@example.com", ip, recent);

  const blocked = mintAllowed(db, ip);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "key_minting_limit_per_ip");
  const halfDay = 12 * 3600;
  assert.ok(
    blocked.retry_after_s! > halfDay - 300 && blocked.retry_after_s! < halfDay + 300,
    `retry_after_s ${blocked.retry_after_s} should be ~12h`,
  );
});

/* ---------------- MCP surface ---------------- */

async function rpc(body: unknown) {
  const res = await fetch(`${base()}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test("MCP error results set isError and carry the structured contract + docs", async () => {
  const { status, body } = await rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "get_merchant", arguments: { merchant_id: "00000000-0000-4000-8000-999999999999" } },
  });
  assert.equal(status, 200);
  assert.equal(body.result.isError, true);
  const payload = JSON.parse(body.result.content[0].text);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, "unknown_merchant");
  assert.equal(payload.field, "merchant_id");
  assert.ok(payload.message);
  assert.equal(payload.docs, `${base()}${DOCS_PATH}`); // derived from the HTTP request
});

test("MCP success results do NOT set isError or grow a docs field", async () => {
  const { body } = await rpc({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "get_merchant", arguments: { merchant_id: merchantId } },
  });
  assert.equal(body.result.isError, undefined);
  const payload = JSON.parse(body.result.content[0].text);
  assert.equal(payload.merchant_id, merchantId);
  assert.equal(payload.docs, undefined);
});

test("MCP auth failure carries the structured contract in error.data", async () => {
  const res = await fetch(`${base()}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-api-key": "reg_not_a_real_key",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
  });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error.message, "invalid_api_key");
  assert.equal(body.error.data.error, "invalid_api_key");
  assert.ok(body.error.data.message);
  assert.ok(body.error.data.docs.endsWith(DOCS_PATH));
});
