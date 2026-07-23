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
export function mintAllowed(db: Database, ip: string): { ok: boolean; error?: string } {
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const perIp = (
    db.prepare("SELECT COUNT(*) c FROM api_keys WHERE created_ip = ? AND created_at >= ?").get(ip, dayAgo) as { c: number }
  ).c;
  if (perIp >= config.mcp.keysPerIpPerDay) return { ok: false, error: "key_minting_limit_per_ip" };
  const global = (
    db.prepare("SELECT COUNT(*) c FROM api_keys WHERE created_at >= ?").get(dayAgo) as { c: number }
  ).c;
  if (global >= config.mcp.keysPerDayGlobal) return { ok: false, error: "key_minting_limit_global" };
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
    const { developer_name, contact, webhook_url } = req.body ?? {};
    if (typeof developer_name !== "string" || !developer_name.trim() || developer_name.length > 80)
      return res.status(400).json({ error: "developer_name required (1-80 chars)" });
    if (typeof contact !== "string" || !contact.trim() || contact.length > 120)
      return res.status(400).json({ error: "contact required (1-120 chars)" });
    if (webhook_url !== undefined && (typeof webhook_url !== "string" || webhook_url.length > 300 || !isHttpUrl(webhook_url)))
      return res.status(400).json({ error: "webhook_url must be an http(s) URL (max 300 chars)" });

    const ip = req.ip ?? "unknown";
    const allowed = mintAllowed(db, ip);
    if (!allowed.ok) {
      return res.status(429).json({
        error: allowed.error,
        note: `Self-serve keys are limited to ${config.mcp.keysPerIpPerDay}/day per client. Contact the registry to raise your limit.`,
      });
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
