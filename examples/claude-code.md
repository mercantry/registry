# Connect Claude Code / Claude Desktop to Mercantry

Reads need no key and no signup. Everything below is copy-paste.

## Claude Code (one line)

```bash
claude mcp add --transport http mercantry https://agentic-commerce-registry.fly.dev/mcp
```

With an optional developer key (attribution + abuse control — it never unlocks
data; see [`../docs/mcp-tools.md`](../docs/mcp-tools.md)):

```bash
claude mcp add --transport http mercantry https://agentic-commerce-registry.fly.dev/mcp \
  --header "Authorization: Bearer reg_your_key_here"
```

Verify the connection, then ask for something real:

```
/mcp                      # mercantry should be listed as connected
```
> Find bookable restaurants for a party of 2, then show me the full record for
> the first one — including where each field came from.

## Claude Desktop (config file)

Add the `mercantry` block to your MCP servers config — see
[`claude_desktop_config.json`](claude_desktop_config.json) for the whole file:

```json
{
  "mcpServers": {
    "mercantry": {
      "type": "http",
      "url": "https://agentic-commerce-registry.fly.dev/mcp"
    }
  }
}
```

Config file location: `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) · `%APPDATA%\Claude\claude_desktop_config.json` (Windows). Restart
Claude Desktop after editing.

## Running against your own instance

The registry is Apache-2.0 and runs locally with no external services:

```bash
npm install && npm run dev     # http://localhost:4100 — seeds 500 sandbox merchants on first boot
claude mcp add --transport http mercantry-local http://localhost:4100/mcp
```

`npm run mcp` serves the identical tool set over stdio if you prefer a local
process to an HTTP endpoint.

## What to expect

- **Search is filter-based and never ranked.** Deterministic order
  (`merchant_id` ASC, or `distance` ASC when you pass `lat`/`lng` with
  `order_by: "distance"`), so the same question gets the same page. Your model
  brings taste; the registry brings raw signals.
- **`get_merchant` is a full dump** — every field, structured hours, raw
  feedback, platform-observed stats, and per-field provenance with timestamps.
- **Booking is asynchronous and honest.** `place_booking` returns immediately
  with `state: "queued"`; a call is placed in the background. Poll
  `get_booking_status` or supply a `callback_url`.
- **Real merchants are discovery-only right now** — `place_booking` on one
  returns `fulfillment_not_live` until human-operated fulfillment launches.
  Sandbox merchants (`sandbox: true`, filter with `sandbox: true`) run the
  whole loop and return a *simulated* confirmation, so integration-testing
  never dials a real restaurant. Never relay a sandbox confirmation to a user
  as a real reservation.
- **Always send `client_reference_id` on `place_booking`.** Retrying with the
  same value returns the booking already created instead of double-booking the
  restaurant.
