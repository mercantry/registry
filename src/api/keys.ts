/**
 * Developer API key resolution, shared by the REST mirror and the HTTP MCP
 * transport. Keys are optional in v1 — they exist for abuse control and
 * metrics, not gating (REQ-MCP-4). Presenting an invalid or throttled key is
 * an error; presenting no key is fine.
 */
import type { Database } from "better-sqlite3";
import express from "express";
import { randomUUID, randomBytes } from "node:crypto";
import { now } from "../db/index.js";
import { config } from "../config.js";
import { agentError, docsUrl, statusFor } from "../registry/errors.js";

export interface KeyResolution {
  key_id?: string;
  error?: "invalid_api_key" | "key_throttled_high_no_show_rate";
}

export function resolveApiKey(db: Database, key: string | undefined): KeyResolution {
  if (!key) return {};
  const row = db.prepare("SELECT key_id, throttled FROM api_keys WHERE api_key = ?").get(key) as
    | { key_id: string; throttled: number }
    | undefined;
  if (!row) return { error: "invalid_api_key" };
  if (row.throttled) return { error: "key_throttled_high_no_show_rate" };
  return { key_id: row.key_id };
}

/** Pull a key from either `x-api-key: <key>` or `Authorization: Bearer <key>`. */
export function keyFromHeaders(headers: {
  "x-api-key"?: string | string[];
  authorization?: string | string[];
}): string | undefined {
  const direct = headers["x-api-key"];
  if (typeof direct === "string" && direct) return direct;
  const auth = headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return undefined;
}

/**
 * Gate B (note 002): abuse-guard self-serve key minting. Self-serve stays —
 * open onboarding is the adoption strategy (REQ-DST-2) — but minting is
 * bounded per client IP per day plus a global daily backstop, with input
 * validation. Limits are enforced from the database (created_ip), so they
 * survive restarts.
 */
export function mintAllowed(db: Database, ip: string): { ok: boolean; error?: string; retry_after_s?: number } {
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  // Rolling 24h window: the cap frees up when the oldest counted key ages out.
  const retryAfter = (oldestCreatedAt: string | undefined) =>
    Math.max(60, Math.ceil((new Date(oldestCreatedAt ?? dayAgo).getTime() + 86_400_000 - Date.now()) / 1000));
  const perIp = db
    .prepare("SELECT COUNT(*) c, MIN(created_at) oldest FROM api_keys WHERE created_ip = ? AND created_at >= ?")
    .get(ip, dayAgo) as { c: number; oldest?: string };
  if (perIp.c >= config.mcp.keysPerIpPerDay)
    return { ok: false, error: "key_minting_limit_per_ip", retry_after_s: retryAfter(perIp.oldest) };
  const global = db
    .prepare("SELECT COUNT(*) c, MIN(created_at) oldest FROM api_keys WHERE created_at >= ?")
    .get(dayAgo) as { c: number; oldest?: string };
  if (global.c >= config.mcp.keysPerDayGlobal)
    return { ok: false, error: "key_minting_limit_global", retry_after_s: retryAfter(global.oldest) };
  return { ok: true };
}

const isHttpUrl = (s: string) => {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

/** POST /v1/keys — self-serve issuance (REQ-MCP-4), now abuse-guarded. */
export function keysRouter(db: Database): express.Router {
  const router = express.Router();
  router.post("/", (req, res) => {
    const docs = docsUrl(process.env.PUBLIC_BASE_URL ?? `${req.protocol}://${req.get("host")}`);
    const reject = (code: string) => res.status(statusFor(code)).json({ ...agentError(code), docs });
    const { developer_name, contact, webhook_url } = req.body ?? {};
    if (typeof developer_name !== "string" || !developer_name.trim() || developer_name.length > 80)
      return reject("invalid_developer_name");
    if (typeof contact !== "string" || !contact.trim() || contact.length > 120)
      return reject("invalid_contact");
    if (webhook_url !== undefined && (typeof webhook_url !== "string" || webhook_url.length > 300 || !isHttpUrl(webhook_url)))
      return reject("invalid_webhook_url");

    const ip = req.ip ?? "unknown";
    const allowed = mintAllowed(db, ip);
    if (!allowed.ok) {
      res.setHeader("Retry-After", String(allowed.retry_after_s));
      return res.status(429).json({ ...agentError(allowed.error!), retry_after_s: allowed.retry_after_s, docs });
    }

    const keyId = randomUUID();
    const apiKey = "reg_" + randomBytes(24).toString("base64url");
    db.prepare(
      "INSERT INTO api_keys (key_id, api_key, developer_name, contact, webhook_url, created_ip, created_at) VALUES (?,?,?,?,?,?,?)",
    ).run(keyId, apiKey, developer_name.trim(), contact.trim(), webhook_url ?? null, ip, now());
    res.json({
      key_id: keyId,
      api_key: apiKey,
      rate_limit_per_minute: config.mcp.rateLimitPerMinute,
      note: "All reads and bookings are free in v1. Keys exist for abuse control and metrics.",
    });
  });
  return router;
}
