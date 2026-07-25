/**
 * Rate limiting (REQ-MCP-5): documented limits, returned in headers, applied
 * to both agent surfaces — REST (/v1) and MCP over HTTP (/mcp).
 *
 * Gate B hardening: buckets key on VALID api keys or the client IP — never on
 * unvalidated header values, or rotating junk keys would bypass per-IP limits
 * and grow memory without bound.
 *
 * 429s teach backoff: `Retry-After` header + retry_after_s and
 * limit/remaining/reset in the body, so an agent knows exactly when to resume
 * instead of hammering.
 */
import type { Database } from "better-sqlite3";
import type express from "express";
import { config } from "../config.js";
import { agentError, docsUrl } from "../registry/errors.js";
import { keyFromHeaders, resolveApiKey } from "./keys.js";

export function makeRateLimit(db: Database, limitPerMinute: number = config.mcp.rateLimitPerMinute): express.RequestHandler {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  const prune = setInterval(() => {
    const nowMs = Date.now();
    for (const [id, b] of buckets) if (b.resetAt <= nowMs) buckets.delete(id);
  }, 60_000);
  prune.unref?.();

  return (req, res, next) => {
    const presented = keyFromHeaders(req.headers);
    const validKey = presented && !resolveApiKey(db, presented).error ? presented : undefined;
    const id = (validKey ?? req.ip ?? "anon") as string;
    const nowMs = Date.now();
    let b = buckets.get(id);
    if (!b || b.resetAt <= nowMs) {
      b = { count: 0, resetAt: nowMs + 60_000 };
      buckets.set(id, b);
    }
    b.count++;
    const remaining = Math.max(0, limitPerMinute - b.count);
    const reset = Math.ceil(b.resetAt / 1000);
    res.setHeader("X-RateLimit-Limit", String(limitPerMinute));
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    res.setHeader("X-RateLimit-Reset", String(reset));
    if (b.count > limitPerMinute) {
      const retryAfterS = Math.max(1, Math.ceil((b.resetAt - nowMs) / 1000));
      res.setHeader("Retry-After", String(retryAfterS));
      return res.status(429).json({
        ...agentError("rate_limited"),
        retry_after_s: retryAfterS,
        limit: limitPerMinute,
        remaining: 0,
        reset,
        docs: docsUrl(process.env.PUBLIC_BASE_URL ?? `${req.protocol}://${req.get("host")}`),
      });
    }
    next();
  };
}
