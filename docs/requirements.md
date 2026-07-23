# Registry v1 — Requirements Document

> ⚠️ **LEGAL STATUS — READ BEFORE THE CALLING SECTIONS.** This specification is published in full for openness. The sections describing outbound telephone calls (§6.3 Fulfillment Orchestrator, REQ-FUL-3/8/9, and related) are **design documents only: no automated outbound calling operates, and none will operate until legal review in each target jurisdiction is complete** (the spec itself names this as a launch blocker). Current fulfillment posture: bookings are sandbox-only; when fulfillment launches it is human-operated phone booking on a phone-verified merchant tranche. Merchant data is served from openly licensed sources with per-field provenance; no scraping.

**Product:** Agent-native merchant registry with universal fulfillment (working name: "Registry")
**Version:** v1 (restaurant reservations, single city)
**Status:** Draft for review
**Date:** July 2026

---

## 1. Problem Statement

Agents are becoming the primary interface through which humans discover and transact with real-world services. But the infrastructure agents need does not exist:

1. **No discovery layer.** When an agent is asked to "book me a table," it has no trusted, structured, machine-readable source of merchant data. It falls back on stale training data and scraping human-oriented websites.
2. **No transaction layer.** Even when an agent identifies the right merchant, it cannot complete the booking. Merchants have no MCP endpoints. Workarounds (agent-controlled phones navigating consumer apps) cost more than the transaction itself.
3. **No trust layer.** There is no feedback corpus generated from actual agent-mediated transactions, so agents cannot distinguish reliable merchants from unreliable ones.

**Core thesis:** The customer is the agent, not the human. V1 is designed, measured, and distributed for agents as the primary user.

**Design principle:** One uniform interface, swappable fulfillment backends. Agents integrate once. Behind the interface, fulfillment can be a native merchant MCP, an API bridge, a voice agent, or a human on a phone. The agent never knows or cares. In v1, fulfillment is voice-agent calls with human takeover — meaning every merchant in the registry is bookable on day one, regardless of the merchant's technology.

---

## 2. V1 Goal

**Prove the end-to-end loop: agent query → structured merchant data → confirmed restaurant reservation → verified feedback.**

One city. Restaurants only. Table reservations only (no food ordering, no delivery). Approximately 500 merchants at launch.

### Why restaurants first
- Table reservations require **no payment**, which removes the entire payment rail from v1 scope.
- Transaction is self-contained: confirmation code, no logistics, no returns.
- Fulfillment is achievable by phone, so no merchant permission or integration is required to launch.
- High agent utility: booking is utilitarian (System 2), which is where agents genuinely reduce friction.

### Success criteria (90 days post-launch)
| Metric | Target |
|---|---|
| End-to-end task completion rate (booking request → confirmed reservation) | ≥ 70% |
| Median time from `place_booking` call to confirmation | ≤ 10 minutes |
| Registry data freshness (hours, phone, closure status) | ≥ 95% accurate on audit sample |
| Distinct agent developers / agent instances with ≥ 1 completed booking | ≥ 25 |
| Repeat usage (agent developers with ≥ 5 completed bookings) | ≥ 10 |
| Merchant complaints resulting in blocklist request | ≤ 2% of called merchants |

---

## 3. Non-Goals (V1)

Explicitly out of scope. Listed to prevent scope creep.

- **Hotels, flights, OTA inventory** (Phase 2 — API-bridge based, different build)
- **Food ordering / delivery** (payment + logistics complexity)
- **Payments of any kind** (reservations are free; deposits/prepaid bookings are excluded from v1 — merchants requiring them are flagged `requires_deposit: true` and marked not bookable in v1)
- **Merchant self-serve tools / dashboard** (Phase 3)
- **Native merchant MCP integrations** (the graduation path exists in the schema but no Tier 1/Tier 2 fulfillment is built in v1)
- **Ranking or recommendation of any kind** (permanent non-goal — the registry returns signals, never ordered opinions)
- **Consumer-facing app or website** (agents are the customer; a minimal status page for booking confirmations is the only human-visible surface)
- **Multi-city coverage**
- **Cross-border / multilingual corridor** (Phase 2; schema fields for language support are included in v1 but unpopulated)

---

## 4. Users

### Primary: Agents (and the developers who build them)
- General-purpose assistants (Claude, ChatGPT, etc.) with MCP/connector support
- Agent frameworks and autonomous agents (OpenClaw-class, custom builds)
- Vertical travel/dining agents

Their requirements: structured complete data, deterministic tool behavior, fast queries, honest signals, reliable booking execution, clear state transitions.

### Secondary: Merchants
V1 relationship is **permissionless**: merchants are listed from public data and receive bookings by phone, exactly as they do today from any human caller. Requirements: calls must be professional, bookings must be real (no-show rate managed), opt-out must be honored immediately.

### Tertiary: End humans
The person whose agent is booking. Touchpoints: booking confirmation (relayed through the agent; optional SMS/email), cancellation path. No account, no app.

---

## 5. System Overview

Four components in v1:

```
┌─────────────┐     ┌──────────────┐     ┌────────────────────┐
│  Agent      │────▶│  MCP Server   │────▶│ Fulfillment        │
│  (customer) │◀────│  (interface)  │◀────│ Orchestrator       │
└─────────────┘     └──────┬───────┘     │  ├─ Voice agent    │
                           │             │  └─ Human takeover │
                    ┌──────▼───────┐     └─────────┬──────────┘
                    │  Registry DB  │◀──────────────┘
                    │  (data layer) │     ┌────────────────────┐
                    └──────▲───────┘     │  Ops Console       │
                           │             │  (call center)     │
                    ┌──────┴───────┐     └────────────────────┘
                    │  Ingestion &  │
                    │  Verification │
                    └──────────────┘
```

1. **Registry** — merchant data store + ingestion/verification pipeline
2. **MCP Server** — the agent-facing interface (the product)
3. **Fulfillment Orchestrator** — booking state machine routing to voice agent / human
4. **Ops Console** — internal tool for the call-center team

---

## 6. Functional Requirements

### 6.1 Registry (Data Layer)

#### Merchant schema (core fields)
| Field | Notes |
|---|---|
| `merchant_id` | Stable UUID |
| `name`, `aliases` | Including local-language name field (unpopulated in v1) |
| `category`, `cuisine_tags[]`, `attribute_tags[]` | Attribute tags: outdoor seating, vegetarian-friendly, private rooms, noise level, etc. |
| `location` | Address, lat/long, neighborhood |
| `phone_primary`, `phone_verified_at` | Verification timestamp required for `bookable` status |
| `hours[]` | Structured weekly hours + holiday exceptions |
| `price_band` | 1–4 |
| `reservation_policy` | Walk-in only / phone / accepts reservations / requires deposit |
| `bookable` | Boolean, derived: phone-verified AND accepts phone reservations AND not opted out |
| `fulfillment_channel` | Enum: `native_mcp` \| `api_bridge` \| `voice_agent` \| `human_call`. V1 populates only the last two. Schema supports all four from day one — this is the graduation path. |
| `languages[]` | Unpopulated in v1 |
| `verification_status` | `unverified` \| `phone_verified` \| `transaction_verified` |
| `feedback_summary` | Derived from FeedbackEvents (see 6.4) |
| `operational_stats` | Booking success rate, avg confirmation time, answer rate, no-show reports — computed from platform transactions only |
| `opt_out` | Boolean + timestamp; hard-excludes from booking, retains record marked `not_bookable` |
| `source_provenance[]` | Where each field came from, with timestamps |

#### Ingestion pipeline
- **REQ-ING-1:** Seed ~500 merchants in the launch city from public sources (business registries, public listings, merchant websites). Store per-field provenance.
- **REQ-ING-2:** Phone verification pass on 100% of seeded merchants before launch: confirm number, confirm hours, confirm reservation policy, note deposit requirements. This is performed by the call-center team and doubles as their training.
- **REQ-ING-3:** Freshness policy: hours/phone/closure re-verified at minimum every 60 days; any failed booking call due to bad data triggers immediate re-verification.
- **REQ-ING-4:** Opt-out handling: any merchant requesting removal during any call is flagged within the call, `opt_out` set before end of business day, never called again.

#### Explicit data rules
- **REQ-DATA-1:** No scraped review text from third-party platforms is stored or served (legal exposure + violates the ground-truth principle). Third-party aggregate signals may inform internal verification prioritization but are never exposed via the MCP.
- **REQ-DATA-2:** No ranking fields. There is no "score," no ordered quality metric authored by the platform. Only raw operational stats and transaction-verified feedback.

### 6.2 MCP Server (Agent Interface)

The product surface. Public MCP server, remotely hostable, listed in agent directories.

#### Tools
| Tool | Behavior |
|---|---|
| `search_merchants` | Filter-based (NOT ranked): geo radius / neighborhood, cuisine_tags, attribute_tags, price_band, open_at, bookable_only, party_size supportable. Returns compact records. Pagination. Agent controls all filters; results in deterministic order (e.g., distance or merchant_id) with the ordering rule documented. |
| `get_merchant` | Full signal dump for one merchant: every schema field, full feedback history, operational stats, provenance timestamps. Maximal data, zero opinion. |
| `get_availability` | V1 honest behavior: registry does NOT hold live availability. Returns reservation policy, hours, and `availability_check: "performed_at_booking"`. (Deferred: pre-call availability checks.) |
| `place_booking` | Inputs: merchant_id, party_size, datetime (+ acceptable window ±N minutes), name for reservation, contact for confirmation, special requests (free text ≤ 280 chars), agent callback preference. Returns `booking_id` + state `pending`. Async fulfillment. |
| `get_booking_status` | Returns state machine position: `pending → in_progress → confirmed / failed / needs_input`, plus structured details (confirmed time, merchant instructions) or structured failure reason (`no_answer`, `fully_booked`, `closed`, `policy_mismatch`, `merchant_declined`, `bad_data`). |
| `modify_booking` / `cancel_booking` | Same async pattern. Cancellation is mandatory in v1 — no-shows destroy merchant trust and poison the feedback corpus. |
| `submit_feedback` | Only accepted against a `confirmed` booking_id, within 14 days, once per booking. Structured fields (showed_up honored? wait time? matched description?) + short free text. |
| `get_registry_meta` | Coverage stats, city, merchant counts, data freshness stats, schema version. Lets agents (and their developers) evaluate the registry itself. |

#### Interface requirements
- **REQ-MCP-1:** All tool responses are structured JSON with a published, versioned schema. Breaking changes require version bump and 90-day deprecation window.
- **REQ-MCP-2:** `needs_input` state: if fulfillment hits an ambiguity (e.g., "7pm unavailable, 8:30 offered"), booking pauses in `needs_input` with structured options; agent resolves via `place_booking` amendment or auto-accept rules provided at booking time (`accept_within_window: true` recommended default).
- **REQ-MCP-3:** Webhook/callback support for booking state changes (agents shouldn't have to poll; polling remains supported).
- **REQ-MCP-4:** API keys per agent developer. Free tier generous; keys exist for abuse control and metrics, not monetization (v1 is free — see §9).
- **REQ-MCP-5:** Rate limits documented and returned in headers. Bulk read endpoint for whole-city ingestion by serious agent developers (this is encouraged, not fought — open data is the adoption strategy).
- **REQ-MCP-6:** Documentation written for agents first: machine-readable tool descriptions optimized for LLM tool selection, with example transcripts. Human docs second.

### 6.3 Fulfillment Orchestrator

Booking state machine + routing.

- **REQ-FUL-1:** State machine: `pending → queued → in_progress (call placed) → confirmed | failed | needs_input`, with every transition timestamped and auditable.
- **REQ-FUL-2:** Routing policy per merchant record: `voice_agent` (default) or `human_call` (flagged merchants: complex, previously hostile to robocalls, high-value). Human takeover available mid-call in both directions.
- **REQ-FUL-3:** Voice agent: outbound calling stack (Retell/Vapi-class), script covers: identify as booking service calling on behalf of a customer, request table, handle counter-offers within the agent-authorized window, capture confirmation details, gracefully hand off to human on confusion or merchant request.
- **REQ-FUL-4:** Human-in-the-loop console: live transcript, one-click takeover, disposition codes on wrap-up. Every voice-agent call is human-monitorable during launch phase (first 60 days: 100% monitored; then sampled).
- **REQ-FUL-5:** Call windows respect merchant local hours and avoid peak service windows where possible (configurable per merchant; default: avoid 12:00–13:30 and 18:30–20:30 local for booking calls when the booking is >4h away).
- **REQ-FUL-6:** Retry policy: `no_answer` → up to 3 attempts across 90 minutes, then `failed(no_answer)`. All bookings resolve to a terminal state within 4 hours or auto-fail with reason.
- **REQ-FUL-7:** Confirmation relay: on `confirmed`, structured confirmation (name, time, party size, merchant instructions) returned to agent; optional SMS/email to end human if contact provided.
- **REQ-FUL-8:** Compliance: outbound calls comply with telemarketing/robocall regulations in the launch jurisdiction — these are transactional calls placed at a consumer's request, not solicitation; disclosure language reviewed by counsel before launch; voice agent always discloses it is an automated assistant when asked, and proactively where required by law. **Legal review is a launch blocker.**
- **REQ-FUL-9:** Merchant experience guardrails: max 1 verification call per merchant per 60 days; booking calls are indistinguishable in burden from normal customer calls; any merchant expressing annoyance twice is auto-flagged for `human_call` routing or courtesy BD outreach.

### 6.4 Feedback System

The long-term moat. Rules are strict from day one:

- **REQ-FBK-1:** Feedback accepted only against confirmed bookings, one per booking, within 14 days.
- **REQ-FBK-2:** Structured-first: fixed fields (honored reservation y/n, seated on time y/n, matched registry description y/n, would-repeat y/n) + optional ≤ 500 char free text.
- **REQ-FBK-3:** Served raw and in aggregate via `get_merchant`. Never editorialized, never weighted into a platform-authored score.
- **REQ-FBK-4:** Merchant-side signals also captured by ops (answered call, honored booking, reported no-show) into `operational_stats` — the platform's own observed data, clearly separated from user feedback.

### 6.5 Ops Console (Internal)

- **REQ-OPS-1:** Queue view: pending bookings, SLA timers, assignment to voice agent or human.
- **REQ-OPS-2:** Live call monitoring + takeover (REQ-FUL-4).
- **REQ-OPS-3:** Merchant record editing with provenance (verification calls update the registry inline).
- **REQ-OPS-4:** Disposition analytics: failure reasons by merchant, voice-agent containment rate (% of calls completed without human takeover), per-operator throughput.
- **REQ-OPS-5:** Opt-out and complaint workflow with same-day SLA.

---

## 7. Non-Functional Requirements

| Requirement | Target |
|---|---|
| MCP read-tool latency (p95) | ≤ 800 ms |
| MCP server uptime | ≥ 99.5% |
| Booking terminal-state SLA | 100% within 4 hours |
| Data freshness | Core fields ≤ 60 days since verification |
| Schema stability | Versioned; 90-day deprecation on breaking changes |
| Privacy | End-human PII (name, contact) stored only as needed for the booking, deletable on request; never exposed via read tools |
| Auditability | Every booking has full event log: tool calls, call recordings/transcripts, state transitions |

---

## 8. Distribution (V1)

The customer is the agent, so distribution = presence in agent tool ecosystems:

- **REQ-DST-1:** Listed in major MCP/connector directories at launch (Anthropic, OpenAI, community registries).
- **REQ-DST-2:** Open, public MCP spec + docs; self-serve API key issuance; working quickstart an agent developer can run in < 10 minutes.
- **REQ-DST-3:** 3–5 design-partner agent developers recruited pre-launch, integrated during beta, with a direct feedback channel. Target mix: one major-assistant power user community, one agent framework, one travel/dining vertical agent.
- **REQ-DST-4:** No consumer marketing. No SEO. The only "content" is developer documentation and the registry's own data quality.

---

## 9. Business Model (V1 posture)

- All registry reads: **free**, no volume anxiety. Being the default first query is the entire strategy.
- Bookings: **free in v1.** Fulfillment cost (voice minutes + human time) is treated as customer acquisition cost for both sides of the network. Estimate and track fully-loaded cost per confirmed booking; target < $3 by day 90 through voice-agent containment.
- Monetization deferred to Phase 2 (per-booking fee to agent developers and/or merchant-side take once volume gives leverage; travel API bridges carry inherited commissions and fund the restaurant side).

---

## 10. Team (V1 minimum)

| Role | Count | Notes |
|---|---|---|
| Founding engineer(s) | 1–2 | Registry + MCP server + orchestrator; managed voice stack keeps this small |
| Ops lead | 1 | Owns call center, verification pipeline, merchant relations |
| Call operators | 2–4 | Bilingual not required in v1; scripted verification + booking calls + voice-agent monitoring; can be contract/BPO |
| Counsel (fractional) | — | Call compliance + scraped-data posture; launch blocker items |

---

## 11. Milestones

| Milestone | Exit criteria |
|---|---|
| **M0 — Foundation** (weeks 1–4) | Schema finalized; ingestion pipeline running; 500 merchants seeded; legal review of calling + data posture complete |
| **M1 — Verified registry** (weeks 4–8) | 100% phone verification pass done; MCP server live with read tools (`search`, `get_merchant`, `get_registry_meta`); listed in ≥ 1 directory; design partners reading data |
| **M2 — First bookings** (weeks 8–12) | `place_booking` live; human-call fulfillment only; 50 confirmed bookings through design partners; state machine + ops console proven |
| **M3 — Voice agent** (weeks 12–16) | Voice agent handling ≥ 50% of calls with human monitoring; containment rate ≥ 60%; cost per confirmed booking trending to target |
| **M4 — Open launch** (week 16+) | Public directory listings, self-serve keys, success-criteria dashboard live; 90-day measurement clock starts |

---

## 12. Key Risks

| Risk | Mitigation |
|---|---|
| Agent demand too early (nobody's agent books tables yet) | Design partners pre-committed before build; registry reads are independently useful even without bookings; keep burn minimal |
| Merchant backlash to automated calls | Human-quality scripts, disclosure, strict opt-out, human routing for sensitive merchants, complaint SLA; the call burden is identical to a normal customer call |
| Regulatory exposure on outbound automated calls | Counsel sign-off as launch blocker; human-initiated fallback mode if voice-agent rules are unfavorable in launch jurisdiction |
| No-shows poison merchant trust | Mandatory cancellation tool; agent developers with high no-show rates throttled; no-show tracked per developer key |
| Data staleness undermines the core promise | Freshness SLA + failed-call-triggered re-verification; `get_registry_meta` exposes freshness stats honestly |
| A platform (OpenTable/Google) ships the same thing | Their incentive is to gatekeep and rank, not to expose open signals; speed + the universal-fulfillment tier (phone) is coverage they won't replicate; feedback corpus compounds |

---

## 13. Open Decisions (need answers before M0)

1. **Launch city.** Ops proximity strongly favors the founder's city; the cross-border corridor thesis (e.g., inbound travelers) can shape *neighborhood/cuisine selection within* the launch city rather than forcing an overseas launch.
2. **Merchant seed composition.** 500 merchants: optimize for booking-likelihood (reservation-taking, mid/upscale) vs. coverage breadth? Recommendation: 80% reservation-taking restaurants in 3–4 dense neighborhoods, 20% breadth.
3. **Voice stack:** build-on (Retell/Vapi/Bland-class) vs. own pipeline. Recommendation: managed platform for v1; containment-rate data informs Phase 2 build/buy.
4. **Availability checking:** v1 ships without pre-call availability (honest `performed_at_booking`). Confirm this is acceptable to design partners or scope a limited "call-ahead check" product.
5. **Naming/entity:** working name, domain, and whether the registry spec is published under an open license from day one (recommended: yes — openness is the moat-inversion strategy).
