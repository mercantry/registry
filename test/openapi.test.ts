/**
 * The /v1 surface must self-describe (marketing machine-surfaces ask):
 * GET /v1 index + GET /v1/openapi.json, complete and honest.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOpenApi, v1Index } from "../src/api/openapi.js";
import { config } from "../src/config.js";

const BASE = "https://registry.example";

test("openapi document covers the full /v1 surface", () => {
  const doc = buildOpenApi(BASE);
  assert.equal(doc.openapi, "3.1.0");
  assert.equal(doc.info.version, config.schemaVersion);
  assert.deepEqual(Object.keys(doc.paths).sort(), [
    "/.well-known/mcp.json",
    "/healthz",
    "/v1/bookings",
    "/v1/bookings/{booking_id}",
    "/v1/bookings/{booking_id}/cancel",
    "/v1/bookings/{booking_id}/feedback",
    "/v1/bookings/{booking_id}/modify",
    "/v1/export/merchants.ndjson",
    "/v1/keys",
    "/v1/merchants",
    "/v1/merchants/{merchant_id}",
    "/v1/meta",
    "/v1/stats",
  ]);
  assert.equal(doc.servers[0].url, BASE);
});

test("openapi document keeps the house rules: no ranking language, honest availability", () => {
  const text = JSON.stringify(buildOpenApi(BASE)).toLowerCase();
  // REQ-DATA-2: the only mentions of ranking must be negations ("not ranked", "never ranks/ranked").
  const rankMentions = text.match(/[^"]{0,12}rank/g) ?? [];
  assert.ok(rankMentions.length > 0, "should explicitly state the no-ranking posture");
  for (const m of rankMentions) {
    assert.match(m, /not |never /, `un-negated ranking language in spec: "${m}"`);
  }
  assert.ok(text.includes("deterministic"), "ordering rule must be documented");
  assert.ok(!text.includes("live availability"), "must not promise live availability");
});

test("v1 index points at the discovery surfaces", () => {
  const idx = v1Index(BASE);
  assert.equal(idx.openapi, `${BASE}/v1/openapi.json`);
  assert.equal(idx.mcp_endpoint, `${BASE}/mcp`);
  assert.equal(idx.schema_version, config.schemaVersion);
  assert.ok(Object.keys(idx.endpoints).length >= 6);
});
