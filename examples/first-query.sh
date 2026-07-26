#!/usr/bin/env bash
# Mercantry — first query in one curl (no key, no setup, no signup).
#
#   ./first-query.sh                       # against the live registry
#   ./first-query.sh http://localhost:4100 # against your own instance
#
# Reads are free and unauthenticated. A developer key is optional and exists
# for attribution and abuse control only — it never unlocks data.
set -euo pipefail

BASE="${1:-${REGISTRY_BASE:-https://agentic-commerce-registry.fly.dev}}"

# 1. Evaluate the registry before trusting it: coverage, freshness, staleness,
#    schema version, and the documented ordering rule all come from one call.
echo "--- registry meta ---"
curl -sS "$BASE/v1/meta" | jq '{schema_version, cities, bookable_count, freshness, booking_policy}'

# 2. Search. Filter-based and never ranked: the order is merchant_id ASC
#    (or distance ASC when you pass lat/lng with order_by=distance), so the
#    same query returns the same page every time.
#
#    sandbox=false keeps the permanent test merchants out of the results.
#    Every record carries `sandbox` either way — see booking-walkthrough.sh.
echo "--- search: bookable, party of 2, real merchants only ---"
curl -sS --get "$BASE/v1/merchants" \
  --data-urlencode "bookable_only=true" \
  --data-urlencode "party_size=2" \
  --data-urlencode "sandbox=false" \
  --data-urlencode "limit=3" \
  | jq '{order, total, results: [.results[] | {merchant_id, name, neighborhood, timezone, bookable, sandbox}]}'

# 3. Full signal dump on one merchant: every schema field, structured hours,
#    raw feedback, platform-observed stats, and per-field provenance with
#    timestamps. Maximal data, zero opinion — the registry never scores.
MERCHANT_ID=$(curl -sS --get "$BASE/v1/merchants" \
  --data-urlencode "bookable_only=true" --data-urlencode "sandbox=false" --data-urlencode "limit=1" \
  | jq -r '.results[0].merchant_id // empty')

if [ -z "$MERCHANT_ID" ]; then
  echo "No bookable real merchants served right now — skipping the detail call."
  exit 0
fi

echo "--- merchant $MERCHANT_ID ---"
curl -sS "$BASE/v1/merchants/$MERCHANT_ID" \
  | jq '{merchant_id, name, timezone, bookable, sandbox, verification_status,
         hours: (.hours | length), provenance_fields: (.source_provenance | length)}'

# Bulk is encouraged, not fought — the whole corpus, one stream:
#   curl -sS "$BASE/v1/export/merchants.ndjson" | head -3
#
# The same tools over MCP: see mcp-json-rpc.sh (raw) or claude-code.md (one line).
