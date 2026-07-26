#!/usr/bin/env bash
# Mercantry over raw MCP (Streamable HTTP) — no SDK, no client library.
#
#   ./mcp-json-rpc.sh                       # against the live registry
#   ./mcp-json-rpc.sh http://localhost:4100 # against your own instance
#
# The endpoint is STATELESS: every POST is independent, there is no session to
# open and no Mcp-Session-Id to carry. `initialize` is accepted but not
# required — you can call tools/list or tools/call directly. GET and DELETE
# answer 405 on purpose: this server has no server-initiated messages, so
# booking updates come from get_booking_status or a callback_url webhook.
#
# Send both content types in Accept — the spec allows either a JSON body or an
# SSE stream, and this server answers with JSON.
set -euo pipefail

BASE="${1:-${REGISTRY_BASE:-https://agentic-commerce-registry.fly.dev}}"
MCP="$BASE/mcp"

# A developer key is optional (attribution + abuse control, never gating):
#   AUTH=(-H "Authorization: Bearer reg_...")   # or -H "x-api-key: reg_..."
AUTH=()

rpc() {
  curl -sS -X POST "$MCP" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    "${AUTH[@]}" \
    -d "$1"
}

# 1. What tools exist, and how they describe themselves to a model.
echo "--- tools/list ---"
rpc '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '[.result.tools[].name]'

# 2. Call one. Arguments are the tool's input schema, verbatim.
echo "--- tools/call search_merchants ---"
rpc '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
       "name":"search_merchants",
       "arguments":{"bookable_only":true,"sandbox":true,"limit":2}}}' \
  | jq -r '.result.content[0].text' \
  | jq '{order, total, results: [.results[] | {merchant_id, name, sandbox}]}'

# 3. Tool results are JSON in a text content block — parse the text, not the
#    envelope. Failures set isError:true and the same text carries the
#    agent-actionable error contract: a stable `error` code plus field /
#    allowed / example / message / docs.
echo "--- tools/call with a bad argument (error contract) ---"
rpc '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{
       "name":"get_merchant",
       "arguments":{"merchant_id":"does-not-exist"}}}' \
  | jq '{isError: .result.isError, error: (.result.content[0].text | fromjson)}'

# 4. The full handshake, if your client insists on one. Nothing here is
#    required by this server; it is shown so a strict MCP client works too.
echo "--- initialize (optional here) ---"
rpc '{"jsonrpc":"2.0","id":4,"method":"initialize","params":{
       "protocolVersion":"2025-06-18",
       "capabilities":{},
       "clientInfo":{"name":"example-client","version":"0.1.0"}}}' \
  | jq '{server: .result.serverInfo, protocolVersion: .result.protocolVersion}'

# Every tool in the list has a REST twin under /v1 with the same JSON shapes —
# see first-query.sh and booking-walkthrough.sh. Use whichever your stack
# already speaks; they are the same product, not two products.
