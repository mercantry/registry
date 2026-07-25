/**
 * Per-merchant timezone arithmetic.
 *
 * Coverage spans multiple IANA zones (America/Los_Angeles, Asia/Tokyo,
 * Asia/Hong_Kong, ...), so datetime handling is merchant-local:
 *  - a naive ISO datetime ("2026-07-18T19:00") means the merchant's own
 *    wall clock;
 *  - an explicit ISO-8601 offset ("2026-07-18T19:00:00+09:00" or a
 *    trailing Z) pins the exact instant.
 *
 * Built on Intl only (no dependency); formatters are cached per zone.
 */

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
    } catch {
      // Unknown zone id: fail safe to UTC rather than throwing on every
      // worker tick. Zone ids come from our own city configs, so this is a
      // defensive backstop, not an expected path.
      f = new Intl.DateTimeFormat("en-CA", {
        timeZone: "UTC",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
    }
    fmtCache.set(tz, f);
  }
  return f;
}

/** True when the ISO datetime string carries an explicit UTC offset (trailing Z or ±hh[:]mm). */
export function hasExplicitOffset(s: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(s.trim());
}

/**
 * Wall clock of a UTC instant in a zone, encoded as a Date whose UTC fields
 * equal the local fields — the getUTC* convention isOpenAt and the
 * structured-hours math already use.
 */
export function toZoneWallClock(instant: Date, tz: string): Date {
  const parts = fmt(tz).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  // Some ICU builds format midnight as "24" with hour12: false.
  return new Date(
    Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second")),
  );
}

/** The zone's UTC offset (ms) at a given instant. */
function zoneOffsetMs(instant: Date, tz: string): number {
  return toZoneWallClock(instant, tz).getTime() - instant.getTime();
}

/**
 * Parse an ISO-8601 datetime into a UTC instant. An explicit offset wins;
 * a naive string is interpreted as wall time in `tz` (two passes settle
 * DST-transition edges). Accepts a space separator ("2026-07-18 19:45").
 * Returns null when unparseable.
 */
export function parseInstant(s: string, tz: string): Date | null {
  const iso = s.trim().replace(" ", "T");
  if (hasExplicitOffset(iso)) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const wallMs = Date.parse(iso + "Z");
  if (Number.isNaN(wallMs)) return null;
  let t = wallMs - zoneOffsetMs(new Date(wallMs), tz);
  t = wallMs - zoneOffsetMs(new Date(t), tz);
  return new Date(t);
}

/** "HH:MM" wall clock of an instant in a zone. */
export function zoneHHMM(instant: Date, tz: string): string {
  return toZoneWallClock(instant, tz).toISOString().slice(11, 16);
}

/** "YYYY-MM-DD" local date of an instant in a zone. */
export function zoneDateStr(instant: Date, tz: string): string {
  return toZoneWallClock(instant, tz).toISOString().slice(0, 10);
}
