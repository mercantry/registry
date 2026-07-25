/**
 * REST-side plumbing for the agent-actionable error contract
 * (registry/errors.ts): status mapping, docs decoration, and the two
 * catch-alls that keep every agent-facing failure machine-readable —
 * unknown /v1 endpoints and thrown/parse errors both used to render as
 * Express's default HTML, which an agent can't self-correct from.
 */
import type express from "express";
import { agentError, docsUrl, statusFor } from "../registry/errors.js";

/** Absolute base for docs links: configured base wins, else derived from the request. */
export function requestBase(req: express.Request): string {
  return process.env.PUBLIC_BASE_URL ?? `${req.protocol}://${req.get("host")}`;
}

/** Send a structured error result: status from the catalog, docs URL attached. */
export function sendError(req: express.Request, res: express.Response, result: { error?: string }): void {
  res.status(statusFor(result.error)).json({ ...result, docs: docsUrl(requestBase(req)) });
}

/** 404 catch-all for unmatched /v1 paths (mount after every /v1 route). */
export const v1NotFound: express.RequestHandler = (req, res) => {
  sendError(req, res, agentError("unknown_endpoint"));
};

/**
 * Final error middleware: JSON, never an HTML stack page. Body-parse
 * failures from express.json() surface as 400s with their own codes;
 * anything else is an honest internal_error.
 */
export const jsonErrorHandler: express.ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);
  const type = (err as { type?: string })?.type;
  if (type === "entity.parse.failed") return sendError(req, res, agentError("invalid_json_body"));
  if (type === "entity.too.large") return sendError(req, res, agentError("payload_too_large"));
  console.error("[api] unhandled error:", err);
  sendError(req, res, agentError("internal_error"));
};
