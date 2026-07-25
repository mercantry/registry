/**
 * Streamable HTTP transport for the Registry MCP server (REQ-MCP-1, remote).
 *
 * Mounted at /mcp on the HTTP server so agents anywhere on the internet can
 * use the registry without a local checkout:
 *
 *   claude mcp add --transport http registry https://<host>/mcp
 *
 * Stateless mode: each POST builds a fresh McpServer + transport pair, so the
 * endpoint needs no session affinity and scales horizontally. GET (server-push
 * SSE) and DELETE (session teardown) are answered 405 per the spec — this
 * server has no server-initiated messages; booking updates flow through
 * get_booking_status polling or place_booking's callback_url webhooks.
 *
 * Auth mirrors the REST surface: keys are optional (v1 is free; keys exist for
 * abuse control + booking attribution). `x-api-key` or `Authorization: Bearer`
 * both work; an invalid or throttled key is rejected, no key is fine.
 */
import type { Database } from "better-sqlite3";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildRegistryServer } from "./registryServer.js";
import { keyFromHeaders, resolveApiKey } from "../api/keys.js";
import { agentError, docsUrl } from "../registry/errors.js";

export function mcpRouter(db: Database): express.Router {
  const router = express.Router();

  // Browser-based agents need CORS; native clients ignore it.
  router.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Accept, Authorization, X-Api-Key, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
    );
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  });

  router.post("/", async (req, res) => {
    const docsBase = process.env.PUBLIC_BASE_URL ?? `${req.protocol}://${req.get("host")}`;
    const auth = resolveApiKey(db, keyFromHeaders(req.headers));
    if (auth.error) {
      // JSON-RPC-shaped auth error; data carries the agent-actionable contract.
      return res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: auth.error, data: { ...agentError(auth.error), docs: docsUrl(docsBase) } },
        id: null,
      });
    }

    const server = buildRegistryServer(db, { apiKeyId: auth.key_id, docsBase });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error("[mcp-http] request failed:", e);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "internal_error" },
          id: null,
        });
      }
    }
  });

  const methodNotAllowed: express.RequestHandler = (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed: this MCP endpoint is stateless (POST only)" },
      id: null,
    });
  };
  router.get("/", methodNotAllowed);
  router.delete("/", methodNotAllowed);

  return router;
}
