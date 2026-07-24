/**
 * Note 004 — operator notifications. The operating model routes real bookings
 * to the `human_call` channel with a sole part-time human operator; this module
 * is the "somehow let me know about new reservation requests": one GitHub issue
 * per real human_call booking in a private ops repo, closed with a
 * disposition comment when the booking reaches a terminal state. GitHub's own
 * notifications deliver the push/email; the issue trail doubles as the audit
 * log. Zero new vendors (the SMS layer is a follow-up behind Twilio-class
 * credentials).
 *
 * Failure posture: notification is best-effort and must never affect booking
 * state. Failed API calls are logged to booking_events and retried on a
 * backoff; a booking with no issue still expires honestly via its SLA.
 */
import type { Database } from "better-sqlite3";
import { config } from "../config.js";
import { now } from "../db/index.js";
import { logEvent } from "./stateMachine.js";

type Row = Record<string, any>;

export interface NotifyOptions {
  repo?: string;
  token?: string;
  includeSandbox?: boolean;
  fetchImpl?: typeof fetch;
}

const RETRY_DELAY_MS = 5 * 60_000;
/** Per-booking API backoff — in-memory is fine: a restart just retries sooner. */
const nextAttemptAt = new Map<string, number>();
const inFlight = new Set<string>();

function resolved(opts: NotifyOptions) {
  return {
    repo: opts.repo ?? config.operatorNotify.repo,
    token: opts.token ?? config.operatorNotify.token,
    includeSandbox: opts.includeSandbox ?? config.operatorNotify.includeSandbox,
    fetchImpl: opts.fetchImpl ?? fetch,
  };
}

/**
 * Worker sweep: open issues for new human_call bookings, close issues for
 * resolved ones. No-op unless NOTIFY_GITHUB_REPO + NOTIFY_GITHUB_TOKEN are set.
 */
export function sweepOperatorNotifications(db: Database, opts: NotifyOptions = {}) {
  const cfg = resolved(opts);
  if (!cfg.repo || !cfg.token) return;
  openNewIssues(db, cfg);
  closeResolvedIssues(db, cfg);
}

function eligibleRows(db: Database, includeSandbox: boolean): Row[] {
  // Non-terminal only: a booking that failed before we ever notified (e.g. the
  // guard refused it) never becomes an operator interruption.
  const rows = db
    .prepare(
      `SELECT b.booking_id, b.party_size, b.requested_time, b.window_minutes, b.special_requests,
              b.state, m.name, m.phone_primary, m.address, m.neighborhood, m.city, m.sandbox
       FROM bookings b JOIN merchants m ON m.merchant_id = b.merchant_id
       WHERE b.notify_issue_number IS NULL
         AND b.state IN ('pending','queued','in_progress','needs_input')
         AND m.fulfillment_channel = 'human_call'`,
    )
    .all() as Row[];
  return rows.filter((r) => !r.sandbox || includeSandbox);
}

function openNewIssues(db: Database, cfg: ReturnType<typeof resolved>) {
  for (const b of eligibleRows(db, cfg.includeSandbox)) {
    const id = b.booking_id as string;
    if (inFlight.has(id) || (nextAttemptAt.get(id) ?? 0) > Date.now()) continue;
    inFlight.add(id);

    const consoleUrl = `${config.publicBaseUrl ?? `http://localhost:${config.apiPort}`}/ops/`;
    const title = `📞 Reservation request: ${b.name} · party of ${b.party_size} @ ${b.requested_time}`;
    const body = [
      `**${b.name}**${b.sandbox ? " _(sandbox — pipeline test, no real call)_" : ""}`,
      ``,
      `| | |`,
      `|---|---|`,
      `| Phone | ${b.phone_primary ?? "—"} |`,
      `| Address | ${b.address}, ${b.neighborhood}, ${b.city} |`,
      `| Requested | ${b.requested_time} (local) ± ${b.window_minutes} min |`,
      `| Party | ${b.party_size} |`,
      `| Special requests | ${b.special_requests ?? "—"} |`,
      ``,
      `Claim, dial, and record the disposition in the [Ops Console](${consoleUrl}) — booking \`${id}\`. The reservation name is shown there (kept out of this issue).`,
      ``,
      `_Auto-fails with \`expired_sla\` if unworked past the ${b.sandbox ? "channel" : "24h"} SLA. This issue closes itself on the terminal state._`,
    ].join("\n");

    githubApi(cfg, `/repos/${cfg.repo}/issues`, "POST", { title, body })
      .then((res) => {
        inFlight.delete(id);
        if (res.ok && res.data?.number) {
          db.prepare("UPDATE bookings SET notify_issue_number = ?, updated_at = ? WHERE booking_id = ?").run(res.data.number, now(), id);
          logEvent(db, id, "operator_notified", { issue: res.data.number, repo: cfg.repo });
        } else {
          nextAttemptAt.set(id, Date.now() + RETRY_DELAY_MS);
          logEvent(db, id, "operator_notify_failed", { status: res.status, phase: "open" });
        }
      })
      .catch((err) => {
        inFlight.delete(id);
        nextAttemptAt.set(id, Date.now() + RETRY_DELAY_MS);
        logEvent(db, id, "operator_notify_failed", { error: String(err), phase: "open" });
      });
  }
}

function closeResolvedIssues(db: Database, cfg: ReturnType<typeof resolved>) {
  const rows = db
    .prepare(
      `SELECT booking_id, notify_issue_number, state, failure_reason, confirmed_time, confirmation_code
       FROM bookings
       WHERE notify_issue_number IS NOT NULL AND notify_issue_closed = 0
         AND state IN ('confirmed','failed','cancelled')`,
    )
    .all() as Row[];

  for (const b of rows) {
    const id = b.booking_id as string;
    const key = `close:${id}`;
    if (inFlight.has(key) || (nextAttemptAt.get(key) ?? 0) > Date.now()) continue;
    inFlight.add(key);

    const disposition =
      b.state === "confirmed"
        ? `✅ Confirmed for ${b.confirmed_time} — code \`${b.confirmation_code}\`.`
        : b.state === "cancelled"
          ? `🚫 Cancelled by the agent.`
          : `❌ Failed: \`${b.failure_reason ?? "unknown"}\`.`;
    const issue = `/repos/${cfg.repo}/issues/${b.notify_issue_number}`;

    githubApi(cfg, `${issue}/comments`, "POST", { body: disposition })
      .then(() =>
        githubApi(cfg, issue, "PATCH", {
          state: "closed",
          state_reason: b.state === "confirmed" ? "completed" : "not_planned",
        }),
      )
      .then((res) => {
        inFlight.delete(key);
        if (res.ok) {
          db.prepare("UPDATE bookings SET notify_issue_closed = 1, updated_at = ? WHERE booking_id = ?").run(now(), id);
          logEvent(db, id, "operator_notify_closed", { issue: b.notify_issue_number, disposition: b.state });
        } else {
          nextAttemptAt.set(key, Date.now() + RETRY_DELAY_MS);
          logEvent(db, id, "operator_notify_failed", { status: res.status, phase: "close" });
        }
      })
      .catch((err) => {
        inFlight.delete(key);
        nextAttemptAt.set(key, Date.now() + RETRY_DELAY_MS);
        logEvent(db, id, "operator_notify_failed", { error: String(err), phase: "close" });
      });
  }
}

async function githubApi(
  cfg: ReturnType<typeof resolved>,
  path: string,
  method: "POST" | "PATCH",
  payload: unknown,
): Promise<{ ok: boolean; status: number; data?: any }> {
  const res = await cfg.fetchImpl(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${cfg.token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "mercantry-operator-notify",
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => undefined);
  return { ok: res.ok, status: res.status, data };
}
