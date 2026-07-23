/**
 * Public aggregate operational stats — the feed for ops monitoring and the
 * team's uptime/health scoreboard (note 001: openness + honesty).
 *
 * Aggregate and PII-free by construction: booking funnel counts, completion
 * rate, failure reasons, voice containment. No reservation names/contacts,
 * no per-operator data, no per-merchant identifiers.
 *
 * Served at GET /v1/stats; snapshotted hourly into docs/ops/ by the
 * ops-snapshot workflow so the team can analyze trends from the repo.
 */
import type { Database } from "better-sqlite3";

type Row = Record<string, any>;

export function publicStats(db: Database) {
  const one = (sql: string) => ((db.prepare(sql).get() as Row) ?? {}).c ?? 0;
  const rows = (sql: string) => db.prepare(sql).all() as Row[];

  const byState: Record<string, number> = {};
  for (const r of rows("SELECT state, COUNT(*) c FROM bookings GROUP BY state")) byState[r.state] = r.c;

  const terminal = (byState.confirmed ?? 0) + (byState.failed ?? 0);
  const confirmTimes = rows(
    `SELECT (julianday(e.at) - julianday(b.created_at)) * 24 * 60 AS mins
     FROM bookings b JOIN booking_events e ON e.booking_id = b.booking_id AND e.to_state = 'confirmed'
     WHERE b.state = 'confirmed'`,
  ).map((r) => r.mins as number).sort((a, b) => a - b);

  const voiceCalls = one("SELECT COUNT(*) c FROM call_attempts WHERE channel = 'voice_agent' AND outcome IS NOT NULL");
  const contained = one("SELECT COUNT(*) c FROM call_attempts WHERE channel = 'voice_agent' AND outcome IS NOT NULL AND taken_over = 0");

  return {
    generated_at: new Date().toISOString(),
    bookings: {
      total: one("SELECT COUNT(*) c FROM bookings"),
      by_state: byState,
      completion_rate_pct: terminal ? Math.round(((byState.confirmed ?? 0) / terminal) * 1000) / 10 : null,
      median_confirmation_minutes: confirmTimes.length
        ? Math.round(confirmTimes[Math.floor(confirmTimes.length / 2)] * 10) / 10
        : null,
      failure_reasons: rows(
        "SELECT failure_reason reason, COUNT(*) c FROM bookings WHERE state = 'failed' GROUP BY failure_reason ORDER BY c DESC",
      ),
    },
    fulfillment: {
      voice_agent_calls: voiceCalls,
      containment_rate_pct: voiceCalls ? Math.round((contained / voiceCalls) * 1000) / 10 : null,
    },
    // Note 004: a part-time human operator works the human_call queue, so
    // queue depth/age must be visible in every ops snapshot.
    queue: {
      oldest_active_minutes: ageMinutes(
        db,
        "SELECT MIN(created_at) t FROM bookings WHERE state IN ('pending','queued','in_progress','needs_input')",
      ),
      human_call: {
        queued: one(
          "SELECT COUNT(*) c FROM bookings b JOIN merchants m ON m.merchant_id = b.merchant_id WHERE b.state = 'queued' AND m.fulfillment_channel = 'human_call'",
        ),
        oldest_queued_minutes: ageMinutes(
          db,
          "SELECT MIN(b.created_at) t FROM bookings b JOIN merchants m ON m.merchant_id = b.merchant_id WHERE b.state = 'queued' AND m.fulfillment_channel = 'human_call'",
        ),
      },
    },
    feedback_count: one("SELECT COUNT(*) c FROM feedback_events"),
    api_keys_issued: one("SELECT COUNT(*) c FROM api_keys"),
  };
}

function ageMinutes(db: Database, sql: string): number | null {
  const t = ((db.prepare(sql).get() as Row) ?? {}).t as string | null;
  if (!t) return null;
  return Math.round((Date.now() - new Date(t).getTime()) / 60_000);
}
