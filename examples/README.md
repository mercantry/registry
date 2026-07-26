# Mercantry examples

Runnable integration snippets for the registry. No signup, no key, no setup —
reads and sandbox bookings are unauthenticated, so every example here works
against the live service the moment you paste it.

Base URL used throughout: `https://agentic-commerce-registry.fly.dev`
(override with `REGISTRY_BASE`, or pass a URL as the first argument to the
shell examples to run against `http://localhost:4100`).

| File | What it shows |
|---|---|
| [`first-query.sh`](first-query.sh) | The 60-second path in curl: evaluate the registry, search, full merchant dump. |
| [`booking-walkthrough.sh`](booking-walkthrough.sh) | The whole booking loop against a sandbox merchant: place → idempotent retry → poll → cancel. |
| [`mcp-json-rpc.sh`](mcp-json-rpc.sh) | Raw MCP over Streamable HTTP — `tools/list`, `tools/call`, the error contract, no SDK. |
| [`claude-code.md`](claude-code.md) | Claude Code one-liner + Claude Desktop config ([`claude_desktop_config.json`](claude_desktop_config.json)). |
| [`openai-agents-sdk.py`](openai-agents-sdk.py) | The registry as an MCP server for the OpenAI Agents SDK. |
| [`langchain-mcp-adapter.py`](langchain-mcp-adapter.py) | The registry's tools as LangChain tools via `langchain-mcp-adapters`. |
| [`webhook-receiver.js`](webhook-receiver.js) | Receiving booking state changes on a `callback_url` instead of polling. |

The shell examples need only `bash`, `curl` and `jq`.

## Five things that will save you a bug

1. **Search is never ranked.** Order is deterministic — `merchant_id` ASC, or
   `distance` ASC when you pass `lat`/`lng` with `order_by: "distance"` — and
   carries no quality signal. There is no score in the schema to read.
2. **Check `sandbox` on every record.** Sandbox merchants are the permanent
   test set: they run the full fulfillment state machine and return a
   **simulated** confirmation, never dialing a real venue. Filter with
   `sandbox=true` to integration-test, `sandbox=false` for anything a human
   will act on. Never relay a sandbox confirmation as a real reservation.
3. **Real-merchant fulfillment is not live yet.** `place_booking` on a real
   merchant returns `fulfillment_not_live` — an honest refusal, not a bug.
   When it launches it is human-operated within a published operator window;
   `get_registry_meta` always tells you the current state.
4. **Always send `client_reference_id`.** Agents retry timeouts; a retried
   `place_booking` without a reference double-books the restaurant. Retrying
   with the *same* reference returns the booking already created
   (`idempotent_replay: true`). REST also accepts an `Idempotency-Key` header.
5. **A naive datetime is the merchant's local wall clock**, not yours and not
   UTC. Every merchant carries an IANA `timezone`; an explicit ISO-8601 offset
   (`2026-07-18T19:00:00+09:00`, or a trailing `Z`) pins an exact instant.

## Errors are meant to be self-corrected from

Every failure — MCP tool result or REST 4xx/5xx — is the same structured shape:
a **stable machine code** in `error` (match it exactly; codes never embed
dynamic values), plus `field`, `allowed`, `example`, `message`, and a `docs`
URL. 429s carry `Retry-After` and `retry_after_s`, so back off by what the
response says rather than guessing. Full catalog:
[`/v1/openapi.json`](https://agentic-commerce-registry.fly.dev/v1/openapi.json).

## Keeping these honest

These files are checked against the live contract in CI (`test/examples.test.ts`):
every endpoint path, MCP tool name and request field they use must exist in the
OpenAPI document and the MCP tool schemas, they must all point at the same base
URL, and the three shell examples are executed end-to-end against a real server
boot. A renamed route or a dropped field fails the build here — so a snippet
that once worked cannot quietly rot into one that doesn't.

More: [MCP tool reference](../docs/mcp-tools.md) · [FAQ](../docs/faq.md) ·
[full specification](../docs/requirements.md)
