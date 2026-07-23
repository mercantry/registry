# Exposing the registry to the internet

The product is agent-facing: it only matters if agents that don't live on this
machine can reach it. This guide covers what to expose, how to deploy, and how
agents connect.

> **Live deployment:** https://agentic-commerce-registry.fly.dev — agents
> connect with
> `claude mcp add --transport http registry https://agentic-commerce-registry.fly.dev/mcp`.
> Every merge to `main` auto-deploys via `.github/workflows/ci-deploy.yml`
> (manual runs: Actions → CI & Deploy → Run workflow).

## The surfaces

One process (`src/api/server.ts`) serves everything:

| Path | What | Public? |
|---|---|---|
| `/mcp` | MCP over Streamable HTTP — **the product** | ✅ yes |
| `/v1/*` | REST mirror, self-serve keys, bulk export | ✅ yes |
| `/status/:booking_id` | booking status page for end humans | ✅ yes |
| `/`, `/ops/api/*` | Ops Console (merchant editing, call takeover, opt-out) | 🔒 **never unauthenticated** |

Set **`OPS_TOKEN`** before anything internet-facing starts. When set, the
console and its API require HTTP Basic auth (any username, the token as the
password) or `Authorization: Bearer <token>`. The server prints a warning at
boot when it is unset. The agent surfaces stay keyless by design — v1 is free;
API keys exist for abuse control and booking attribution, not gating.

## Deploy

### Option A — Fly.io (recommended: HTTPS + persistent volume in ~5 minutes)

`fly.toml` is in the repo root. From a machine with `flyctl`:

```bash
fly launch --no-deploy                       # accepts the checked-in fly.toml
fly volumes create registry_data --size 1    # SQLite lives here
fly secrets set OPS_TOKEN=$(openssl rand -hex 24)
fly deploy
```

Agents connect to `https://<app>.fly.dev/mcp`. Keep the machine count at 1:
SQLite is single-writer, and the fulfillment worker runs in-process
(`auto_stop_machines` is off for the same reason).

#### Continuous deploys

`.github/workflows/ci-deploy.yml` deploys to Fly on every push to `main`
(after tests pass) once a `FLY_API_TOKEN` repository secret exists:

```bash
fly tokens create deploy   # → paste into repo Settings → Secrets → Actions
```

Until the secret is added, the deploy step skips itself with a note instead of
failing CI. Each deploy ends with a smoke test: `/v1/meta` reachable, `/mcp`
lists tools, and the ops console answers 401 without credentials.

### Option B — Docker on any VPS

```bash
OPS_TOKEN=$(openssl rand -hex 24) docker compose up -d
```

This listens on `:4100` with the database on a named volume. Put TLS in front —
e.g. Caddy, which is two lines and auto-provisions certificates:

```
registry.example.com {
    reverse_proxy localhost:4100
}
```

`TRUST_PROXY=1` (the compose default) makes per-IP rate limiting see real
client IPs behind the proxy.

### Option C — quick tunnel from a dev box (demos, not production)

Ephemeral URL, dies with the process, data stays local:

```bash
OPS_TOKEN=devtoken npm run dev
cloudflared tunnel --url http://localhost:4100    # or: ngrok http 4100
```

Hand the printed `https://….trycloudflare.com/mcp` URL to any agent.

## How agents connect

### MCP (preferred)

```bash
# Claude Code
claude mcp add --transport http registry https://<host>/mcp

# claude.ai / Claude Desktop: Settings → Connectors → Add custom connector
#   URL: https://<host>/mcp

# Clients that only speak stdio:
npx mcp-remote https://<host>/mcp
```

The endpoint is **stateless Streamable HTTP** (JSON responses, `POST /mcp`
only — no SSE push stream, no session IDs), so it sits happily behind any load
balancer. Booking updates are delivered by polling `get_booking_status` or via
the `callback_url` webhook on `place_booking`.

Keys are optional but recommended so bookings are attributed to your developer
identity (no-show rates are tracked per key — REQ-FBK-3):

```bash
curl -X POST https://<host>/v1/keys \
  -H 'content-type: application/json' \
  -d '{"developer_name":"my-agent","contact":"dev@example.com"}'
# → { "api_key": "reg_…" }
```

Send it on MCP requests as `Authorization: Bearer reg_…` (or `x-api-key`).
Invalid or throttled keys are rejected with 401; no key at all is fine.

### REST

Everything in [`docs/mcp-tools.md`](mcp-tools.md) has a REST mirror under
`/v1` — see the routes in `src/api/server.ts`. Bulk ingestion is explicitly
supported: `GET /v1/export/merchants.ndjson`.

### Verifying a deployment

```bash
curl -s https://<host>/v1/meta | head -c 400        # registry is up + seeded
curl -s -X POST https://<host>/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
curl -s -o /dev/null -w '%{http_code}\n' https://<host>/ops/api/overview   # must be 401
```

## Environment reference

| Var | Default | Notes |
|---|---|---|
| `PORT` | `4100` | HTTP port for every surface |
| `REGISTRY_DB` | `data/registry.db` | SQLite path — put it on a volume |
| `OPS_TOKEN` | *(unset)* | **Required for internet exposure.** Gates `/` and `/ops/api` |
| `TRUST_PROXY` | *(unset)* | Hops to trust for `X-Forwarded-For` (`1` behind one proxy) |
| `DEMO_ACCELERATE` | `1` | Set `0` in production for real retry/SLA timers |
| `LAUNCH_CITY` / `LAUNCH_TZ` | SF / America/Los_Angeles | Open Decision #1 |
| `PUBLIC_BASE_URL` | *(derived from request)* | Absolute URL used in `/.well-known/mcp.json` links |

## Discovery endpoints (public by design)

- `GET /.well-known/mcp.json` — machine-readable manifest for MCP/agent
  directories and crawlers: endpoint, transport, tool list, data policy.
- `GET /healthz` — cheap probe for uptime monitors (`{"ok":true,...}`).

Both are unauthenticated and included in the CI post-deploy smoke test.

## Operational notes

- **Rate limits:** 300 req/min per key (or per IP when keyless) on `/v1` and
  `/mcp`, returned in `X-RateLimit-*` headers (REQ-MCP-5).
- **Scaling:** one instance only. SQLite in WAL mode is plenty for v1's scale
  (~500 merchants, phone-call-bounded booking volume). Going multi-node means
  moving to Postgres first — do not point two instances at one SQLite file.
- **Backups:** the entire state is one file. `sqlite3 /data/registry.db
  ".backup /data/backup.db"` on a cron, or Fly's `fly volumes snapshots`.
- **PII:** reservation names/contacts are stored for fulfillment and never
  exposed via read tools; the status page shows a booking only to someone
  holding its unguessable `booking_id`.
- **First boot** seeds 500 synthetic merchants when the DB is empty. Real
  ingestion connectors and counsel sign-off remain M4 launch blockers
  (§11) — synthetic data is fine for design partners, not open launch.
