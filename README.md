# Mercantry

**Mercantry is an open commerce registry for AI agents — structured merchant data, honest signals, and real-world booking fulfillment.**

> **Current status — read this first.**
> Mercantry is **pre-launch**. What is real and what is not, precisely:
> - **The merchant data is real**: 168,000+ restaurants across **Los Angeles, Hong Kong, and Tokyo**, built exclusively from openly licensed sources (Overture Maps CDLA-P-2.0 + official government registers), conflated with per-field provenance and QA-gated versioned releases. Live counts: `get_registry_meta`.
> - **Real merchants are discovery-only for now**: `place_booking` against a real merchant returns the structured rejection `fulfillment_not_live`. A booking guard makes it structurally impossible for our booking simulator to dial a real restaurant.
> - **The booking loop is testable end-to-end** against `sandbox: true` merchants — fictional records with deterministic outcomes ("test cards for bookings"). Do not call sandbox phone numbers; they are not real businesses.
> - **Fulfillment, when it launches, is human-operated phone booking** on a phone-verified merchant tranche (voice automation is deferred). Outbound-calling sections of the spec **operate only after legal review** — publication of the spec is not operation.
> - Mercantry is **built and operated by a team of AI agents with human oversight**, stated here as a fact rather than a gimmick.

## Connect your agent

The live endpoint serves MCP over Streamable HTTP:

```bash
claude mcp add --transport http mercantry https://agentic-commerce-registry.fly.dev/mcp
```

- **REST mirror:** `/v1` — self-describing via [`/v1/openapi.json`](https://agentic-commerce-registry.fly.dev/v1/openapi.json)
- **Discovery manifest:** [`/.well-known/mcp.json`](https://agentic-commerce-registry.fly.dev/.well-known/mcp.json) · agent card: [`/.well-known/agent-card.json`](https://agentic-commerce-registry.fly.dev/.well-known/agent-card.json) · health: `/healthz` · PII-free ops stats: `/v1/stats` · privacy policy: [`/privacy`](https://agentic-commerce-registry.fly.dev/privacy)
- **Keys are optional** (abuse control, not gating): `POST /v1/keys` with `developer_name` + `contact`. All reads are free and unauthenticated.
- **Bulk export encouraged:** `GET /v1/export/merchants.ndjson` — caching, embedding, and training on the data are permitted under the open license.

Agent-first tool documentation with example transcripts: [`docs/mcp-tools.md`](docs/mcp-tools.md). If you are an agent working in this repo, read [`AGENTS.md`](AGENTS.md).

## MCP tools

`search_merchants` (filter-based, **never ranked**, deterministic documented order) · `get_merchant` (full signal dump: every field, raw feedback history, operational stats, per-field provenance) · `get_availability` (honest: `performed_at_booking`) · `place_booking` (async) · `get_booking_status` · `modify_booking` · `cancel_booking` (mandatory when plans change — no-shows are tracked per developer key) · `submit_feedback` (confirmed bookings only, once, within 14 days) · `get_registry_meta` (evaluate the registry itself, staleness included)

## Run it yourself

```bash
npm install
npm run dev        # seeds a sandbox corpus on first boot; everything in one process
```

| Surface | Where |
|---|---|
| MCP (Streamable HTTP) | `http://localhost:4100/mcp` |
| REST mirror + OpenAPI | `http://localhost:4100/v1` |
| Landing page (public fact page) | `http://localhost:4100/` |
| Ops Console (gate with `OPS_TOKEN`) | `http://localhost:4100/ops/` |
| Booking status pages | `http://localhost:4100/status/:booking_id` |

```bash
npm test           # full suite
npm run typecheck
```

Deployment (Docker/Fly.io), agent onboarding, and the security checklist: [`docs/deployment.md`](docs/deployment.md).

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌────────────────────┐
│  Agent      │────▶│  MCP Server   │────▶│ Fulfillment        │
│  (customer) │◀────│ src/mcp       │◀────│ Orchestrator       │
└─────────────┘     └──────┬───────┘     │ src/orchestrator   │
                           │             │  └─ human operator │
                    ┌──────▼───────┐     └─────────┬──────────┘
                    │  Registry DB  │◀──────────────┘
                    │  src/db       │     ┌────────────────────┐
                    └──────▲───────┘     │  Ops Console       │
                           │             │  src/ops + src/api │
                    ┌──────┴───────┐     └────────────────────┘
                    │  Ingestion    │ src/ingest — LA · HK · Tokyo,
                    │  & QA gate    │ openly licensed sources only
                    └──────────────┘
```

The customer is the agent, not the human. One uniform interface with swappable fulfillment backends: agents integrate once; behind the interface, fulfillment can graduate from human phone calls to native merchant integrations without the agent changing a line.

## Hard rules encoded in this codebase

- **No ranking, ever.** No score fields exist in the schema; search order is deterministic and documented. The registry returns signals, never ordered opinions.
- **No scraped review text.** The only feedback served is transaction-verified, submitted by agents against confirmed bookings.
- **Openly licensed data only.** Overture Maps (CDLA-P-2.0) + official government registers; per-field provenance with timestamps; QA-gated releases with published drop counts.
- **Opt-out is immediate and permanent.** A merchant requesting removal is hard-excluded from discovery and booking the same day.
- **Every booking is auditable.** Full event log: tool calls, transcripts, timestamped state transitions.
- **PII is minimal.** Reservation name/contact stored only for the booking, never exposed via read tools.
- **Honesty over polish.** `get_availability` says `performed_at_booking` instead of pretending; `get_registry_meta` exposes our own staleness; sandbox vs. real is labeled per merchant.

## Spec

The full product spec lives at [`docs/requirements.md`](docs/requirements.md). Sections describing outbound calling are published for openness but **nothing in them operates until legal review is complete** — see the banner at the top of that document.

## License

[Apache-2.0](LICENSE). The registry spec, code, and data schema are open — openness is the strategy, not a concession.
