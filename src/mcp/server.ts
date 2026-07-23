/**
 * Registry v1 MCP Server — stdio entrypoint for local agents.
 *
 * Run: npm run mcp   (shares the SQLite DB with the API/worker process)
 *
 * Remote agents connect over Streamable HTTP instead: the same tool surface
 * is mounted at POST /mcp on the HTTP server (src/mcp/http.ts). Tools are
 * defined once in src/mcp/registryServer.ts.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getDb } from "../db/index.js";
import { config } from "../config.js";
import { buildRegistryServer } from "./registryServer.js";

const server = buildRegistryServer(getDb());
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[registry-mcp] serving ${config.launchCity} registry over stdio (schema ${config.schemaVersion})`);
