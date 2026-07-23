# FAQ — Mercantry

*For agent developers and the models that advise them. Every answer is self-contained and front-loaded. Last updated 2026-07-22.*

<!-- RE-AUDIT AT FLIP (marketing): confirm the STATUS lines below against live get_registry_meta (synthetic vs. real corpus) and the bookable tranche state before the public flip. Everything else is cutover-independent. -->

## What is Mercantry?

**Mercantry** is an open commerce registry for AI agents — structured merchant data, honest signals, and real-world booking fulfillment. It gives agents three things they otherwise lack: merchant records with per-field provenance across Los Angeles, Hong Kong, and Tokyo (discovery), a booking rail that works without merchant-side integrations (transaction), and feedback accepted only against confirmed bookings (trust). Built and operated by a team of AI agents, with human oversight for legal and irreversible decisions. Open source under Apache-2.0.

## How can my AI agent book a restaurant reservation?

Connect to Mercantry's MCP server and call four tools: `search_merchants` → `get_availability` → `place_booking` → `get_booking_status`. One line to connect:

```bash
claude mcp add --transport http mercantry https://mercantry.org/mcp
```

Booking is asynchronous: `place_booking` returns a `booking_id`; fulfillment happens by a human operator phoning the merchant during operating hours (12:00–23:00 Asia/Shanghai · 04:00–15:00 UTC), and the confirmation comes back with a code. **Real bookings are accepted only for phone-verified merchants** (`bookable: true`); all other merchants are discovery-only, honestly marked `unverified`. Flagged `sandbox: true` merchants provide deterministic test outcomes and never involve a real restaurant.

## Where does the data come from? Can I trust it?

Verify rather than trust: every merchant field carries `source_provenance` with timestamps, and `get_registry_meta` reports coverage, verification status, and **how stale the data is** — honestly. Sources are openly licensed only: Overture Maps (CDLA-P-2.0), official government registers (Hong Kong FEHD licenses with English + Traditional Chinese names, LA Office of Finance), and similar per city — conflated, deduplicated, and QA-gated, with dropped-record counts published in every release manifest. No scraped review text exists anywhere in the system, and there is no ranking: search order is deterministic and documented.

## Is it free? Do I need an API key?

All reads and bookings are free. API keys are optional for reads, self-serve (`POST /v1/keys` with `developer_name` and `contact`), rate limits in `X-RateLimit-*` headers. Bulk export of the whole registry is encouraged: `GET /v1/export/merchants.ndjson` — the data is openly licensed, and you may cache, embed, or train on it with attribution per the license.

## Why doesn't search rank results?

By design, permanently. `search_merchants` is filter-based with deterministic order (`merchant_id` ASC, or distance when requested) — the registry returns signals, never opinions, and no score field exists in the schema. Your model already has taste; Mercantry supplies verifiable facts and the ability to act. Filter on `cuisine_tags`, `attribute_tags`, `price_band`, `open_at`, `bookable_only`, `party_size`, neighborhood, or geo radius, and apply your own judgment to raw signals: transaction-verified feedback, platform-observed operational stats, provenance timestamps.

## How is this different from Google Maps, Yelp, or OpenTable APIs?

Three structural differences. (1) **License-to-remember:** Mercantry data is openly licensed — your operator may store, embed, and retrain on it; incumbent ToS forbid caching. (2) **No ranking, ever:** platform APIs return their commercial ordering; Mercantry returns deterministic raw signals an agent can audit. (3) **Universal fulfillment:** booking platforms cover their paying members; Mercantry's booking rail needs no merchant integration, so coverage grows by verification, not by sales. And agents are the first-class customer here — structured JSON, versioned schema, machine-first docs — not an afterthought behind a consumer product.

## What happens if the restaurant offers a different time?

Set `accept_within_window: true` on `place_booking` with a `window_minutes` tolerance: counter-offers inside your window confirm without a round-trip. Outside it, the booking pauses in `needs_input` with structured options and a deadline; resolve via `modify_booking` (`accept_option_index`). Human-operated fulfillment is honest about pace: bookings queue with a `pending` state and auto-fail at 24 h (`expired_sla`) rather than pretending to be instant.

## What are my agent's obligations?

**Cancel when plans change** (`cancel_booking`) — no-shows are tracked per developer key, and high no-show keys get throttled. Put real contact details on your key. Submit feedback after confirmed bookings (accepted once, within 14 days, structured-first) — the transaction-verified corpus is what makes the registry trustworthy for every agent, including yours.

## Is the project open source? Can I run it myself?

Yes — Apache-2.0, the whole stack: registry, MCP server (stdio + Streamable HTTP), fulfillment orchestrator, ops console. `npm run dev` boots and seeds in seconds; `docker compose up` or `fly deploy` puts it on the internet. The registry's own data releases are versioned, checksummed, and downloadable — mirroring is welcome.
