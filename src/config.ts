/**
 * Central configuration for Registry v1.
 *
 * DEMO_ACCELERATE (default: on) shrinks fulfillment timers so the whole
 * booking loop can be observed in seconds instead of hours. Production
 * values (per requirements REQ-FUL-5/6) are documented next to each knob.
 */

const accelerate = process.env.DEMO_ACCELERATE !== "0";

export const config = {
  /** Open Decision #1 — launch city. Configurable; SF is the working default. */
  launchCity: process.env.LAUNCH_CITY ?? "San Francisco, CA",
  timezone: process.env.LAUNCH_TZ ?? "America/Los_Angeles",

  dbPath: process.env.REGISTRY_DB ?? "data/registry.db",
  apiPort: Number(process.env.PORT ?? 4100),

  /**
   * Internet exposure knobs (docs/deployment.md):
   *  - OPS_TOKEN gates the Ops Console + /ops/api (Basic or Bearer). Unset = open (local dev only).
   *  - TRUST_PROXY tells Express how many proxy hops to trust so per-IP rate
   *    limiting sees real client IPs behind a load balancer/tunnel ("1", "true", "loopback").
   */
  opsToken: process.env.OPS_TOKEN || undefined,
  trustProxy: process.env.TRUST_PROXY || undefined,
  /** Absolute base URL used in the discovery manifest; derived from the request when unset. */
  publicBaseUrl: process.env.PUBLIC_BASE_URL || undefined,

  schemaVersion: "1.0.0",

  demoAccelerate: accelerate,

  fulfillment: {
    /** REQ-FUL-6: up to 3 attempts across 90 minutes on no_answer. */
    maxCallAttempts: 3,
    /** Production: 30 min between retries. Demo: 20 s. */
    retryDelayMs: accelerate ? 20_000 : 30 * 60_000,
    /** REQ-FUL-6: every booking resolves to a terminal state within 4 h. Demo: 10 min. */
    terminalSlaMs: accelerate ? 10 * 60_000 : 4 * 60 * 60_000,
    /** needs_input bookings auto-fail if unresolved. Production: 2 h. Demo: 5 min. */
    needsInputTimeoutMs: accelerate ? 5 * 60_000 : 2 * 60 * 60_000,
    /** REQ-FUL-5: avoid peak service windows when booking is >4h away. */
    avoidWindows: [
      { start: "12:00", end: "13:30" },
      { start: "18:30", end: "20:30" },
    ],
    peakAvoidanceHorizonMs: 4 * 60 * 60_000,
    /** Simulated voice-agent call pacing (transcript line cadence). */
    simLineDelayMs: accelerate ? 1_800 : 6_000,
    /**
     * Booking guard (note 004 discovery-only cutover): fulfillment channels that
     * are LIVE for real (non-sandbox) merchants. Empty = fulfillment is not live
     * for any real merchant yet — every non-sandbox booking is rejected with
     * `fulfillment_not_live`, and voiceSim may only ever dial sandbox merchants.
     * When the human-operator flow (note 004) launches, add "human_call" here.
     */
    liveChannels: [] as readonly string[],
    /**
     * Note 004: per-channel terminal SLA. REQ-FUL-6's 4h default predates a
     * sole part-time human operator — human_call bookings queue until worked,
     * with an honest 24h auto-fail (`expired_sla`). Channels not listed here
     * use terminalSlaMs. Production: 24 h. Demo: 20 min.
     */
    channelSlaMs: {
      human_call: accelerate ? 20 * 60_000 : 24 * 60 * 60_000,
    } as Record<string, number>,
    /**
     * Note 004: the human operator's declared availability (set
     * 07-16): 12:00–23:00 Beijing time. Surfaced to agents via
     * get_registry_meta so expectations match a part-time human operator.
     */
    operatorWindow: {
      timezone: "Asia/Shanghai",
      start: "12:00",
      end: "23:00",
    },
  },

  /**
   * Note 004: "somehow let me know about new reservation requests" — one GitHub
   * issue per real human_call booking in a private ops repo; the
   * operator gets push/email via GitHub notifications, the issue closes on
   * terminal state. Repo/token unset = notifications disabled (dev/test).
   * Secrets live in Fly secrets, never in git.
   */
  operatorNotify: {
    /** "owner/name" repo that receives reservation-request issues. */
    repo: process.env.NOTIFY_GITHUB_REPO || undefined,
    token: process.env.NOTIFY_GITHUB_TOKEN || undefined,
    /** Also notify for sandbox human_call bookings — pipeline testing only. */
    includeSandbox: process.env.NOTIFY_INCLUDE_SANDBOX === "1",
  },

  feedback: {
    /** REQ-FBK-1: feedback window after confirmation. */
    windowDays: 14,
    maxFreeTextChars: 500,
  },

  registry: {
    /** REQ-ING-3: core fields re-verified at minimum every 60 days. */
    freshnessDays: 60,
    /** REQ-FUL-9: max 1 verification call per merchant per 60 days. */
    minVerificationIntervalDays: 60,
  },

  mcp: {
    /** REQ-MCP-5: documented rate limits (returned in headers on the HTTP API). */
    rateLimitPerMinute: 300,
    /** Gate B (note 002): self-serve key minting caps — per client IP and global, per rolling 24h. */
    keysPerIpPerDay: 3,
    keysPerDayGlobal: 100,
    searchPageSizeDefault: 20,
    searchPageSizeMax: 100,
    specialRequestMaxChars: 280,
  },
} as const;

export type Config = typeof config;
