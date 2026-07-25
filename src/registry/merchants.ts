import type { Database } from "better-sqlite3";
import { now } from "../db/index.js";
import { config } from "../config.js";
import { hasExplicitOffset, toZoneWallClock } from "./time.js";
import type {
  FeedbackSummary,
  HolidayException,
  HoursBlock,
  Merchant,
  OperationalStats,
  SearchFilters,
} from "./types.js";

type Row = Record<string, any>;

/**
 * The bookable derivation (schema §6.1):
 * phone-verified AND accepts phone reservations AND not opted out.
 * Deposit-requiring merchants are flagged and not bookable in v1 (§3 non-goals).
 */
export function deriveBookable(row: {
  phone_verified_at: string | null;
  reservation_policy: string;
  opt_out: number | boolean;
  requires_deposit: number | boolean;
}): boolean {
  const acceptsPhone =
    row.reservation_policy === "phone_reservations" ||
    row.reservation_policy === "accepts_reservations";
  return Boolean(row.phone_verified_at) && acceptsPhone && !row.opt_out && !row.requires_deposit;
}

export function rowToMerchant(row: Row): Merchant {
  return {
    merchant_id: row.merchant_id,
    name: row.name,
    aliases: JSON.parse(row.aliases),
    category: row.category,
    cuisine_tags: JSON.parse(row.cuisine_tags),
    attribute_tags: JSON.parse(row.attribute_tags),
    location: {
      address: row.address,
      neighborhood: row.neighborhood,
      city: row.city,
      lat: row.lat,
      lng: row.lng,
    },
    timezone: row.timezone ?? null,
    phone_primary: row.phone_primary,
    phone_verified_at: row.phone_verified_at,
    hours: JSON.parse(row.hours),
    holiday_exceptions: JSON.parse(row.holiday_exceptions),
    price_band: row.price_band,
    reservation_policy: row.reservation_policy,
    requires_deposit: Boolean(row.requires_deposit),
    bookable: deriveBookable(row as any),
    fulfillment_channel: row.fulfillment_channel,
    languages: JSON.parse(row.languages),
    verification_status: row.verification_status,
    opt_out: Boolean(row.opt_out),
    sandbox: Boolean(row.sandbox),
    max_party_size: row.max_party_size,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getMerchantRow(db: Database, merchantId: string): Row | undefined {
  return db.prepare("SELECT * FROM merchants WHERE merchant_id = ?").get(merchantId) as
    | Row
    | undefined;
}

export function getMerchant(db: Database, merchantId: string): Merchant | null {
  const row = getMerchantRow(db, merchantId);
  return row ? rowToMerchant(row) : null;
}

export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Is the merchant open at the given local datetime, honoring holiday exceptions and past-midnight closes? */
export function isOpenAt(
  hours: HoursBlock[],
  exceptions: HolidayException[],
  at: Date,
): boolean {
  const dateStr = at.toISOString().slice(0, 10);
  const minutes = at.getUTCHours() * 60 + at.getUTCMinutes();
  const toMin = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
  };

  const ex = exceptions.find((e) => e.date === dateStr);
  if (ex) {
    if (ex.closed) return false;
    if (ex.open && ex.close) return minutes >= toMin(ex.open) && minutes < toMin(ex.close);
  }

  const day = at.getUTCDay();
  const prevDay = (day + 6) % 7;
  for (const block of hours) {
    const open = toMin(block.open);
    const close = toMin(block.close);
    if (close > open) {
      if (block.day === day && minutes >= open && minutes < close) return true;
    } else {
      // service past midnight: today's block covers evening; yesterday's block covers early morning
      if (block.day === day && minutes >= open) return true;
      if (block.day === prevDay && minutes < close) return true;
    }
  }
  return false;
}

export interface SearchResultItem {
  merchant_id: string;
  name: string;
  cuisine_tags: string[];
  attribute_tags: string[];
  neighborhood: string;
  address: string;
  timezone: string | null;
  lat: number;
  lng: number;
  price_band: number;
  reservation_policy: string;
  bookable: boolean;
  verification_status: string;
  distance_km?: number;
}

/**
 * Filter-based search — NOT ranked (REQ-DATA-2). Deterministic ordering:
 * merchant_id (default) or distance when a geo point is supplied. Ordering rule is
 * documented in the tool description; ties on distance break by merchant_id.
 */
export function searchMerchants(
  db: Database,
  f: SearchFilters,
): { results: SearchResultItem[]; total: number; order: string } {
  /**
   * Filters are pushed into SQL (evaluated in C, no per-row JS materialization
   * — required at 169k rows; the old select-all scan cost ~5s per query).
   * Semantics are unchanged: same predicates, same deterministic ordering.
   * open_at (structured-hours logic) and exact haversine distance remain in
   * JS, applied to the SQL-narrowed set; geo gets a bbox pre-filter in SQL.
   */
  const where: string[] = ["opt_out = 0"]; // opted-out merchants are retained but never served for discovery
  const params: unknown[] = [];
  if (f.neighborhood) {
    where.push("neighborhood = ? COLLATE NOCASE");
    params.push(f.neighborhood);
  }
  if (f.price_band_min) {
    where.push("price_band >= ?");
    params.push(f.price_band_min);
  }
  if (f.price_band_max) {
    where.push("price_band <= ?");
    params.push(f.price_band_max);
  }
  if (f.party_size) {
    where.push("max_party_size >= ?");
    params.push(f.party_size);
  }
  if (f.bookable_only) {
    // Same predicate as deriveBookable/registryMeta.
    where.push(
      "phone_verified_at IS NOT NULL AND requires_deposit = 0 AND reservation_policy IN ('phone_reservations','accepts_reservations')",
    );
  }
  if (f.cuisine_tags?.length) {
    // Match ANY: tags are stored lowercase.
    where.push(
      `EXISTS (SELECT 1 FROM json_each(merchants.cuisine_tags) WHERE json_each.value IN (${f.cuisine_tags.map(() => "?").join(",")}))`,
    );
    params.push(...f.cuisine_tags.map((t) => t.toLowerCase()));
  }
  for (const tag of f.attribute_tags ?? []) {
    // Match ALL: one EXISTS per required attribute.
    where.push("EXISTS (SELECT 1 FROM json_each(merchants.attribute_tags) WHERE json_each.value = ?)");
    params.push(tag.toLowerCase());
  }
  if (f.near) {
    // Bbox pre-filter; exact haversine + radius check stays in JS below.
    const latDelta = f.near.radius_km / 110.574;
    const lngDelta = f.near.radius_km / (111.32 * Math.max(Math.cos((f.near.lat * Math.PI) / 180), 0.01));
    where.push("lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?");
    params.push(f.near.lat - latDelta, f.near.lat + latDelta, f.near.lng - lngDelta, f.near.lng + lngDelta);
  }
  const whereSql = where.join(" AND ");

  /**
   * open_at semantics (multi-city): a naive datetime is each merchant's own
   * local wall clock (one wall time, applied per merchant); an explicit
   * ISO-8601 offset pins an instant, converted to each merchant's zone before
   * the structured-hours check. Unparseable input fails fast instead of
   * crashing the hours math downstream.
   */
  let openAtWall: Date | null = null; // fake-UTC encoding of the wall clock (isOpenAt convention)
  let openAtInstant: Date | null = null;
  if (f.open_at) {
    const iso = f.open_at.trim().replace(" ", "T");
    if (hasExplicitOffset(iso)) {
      openAtInstant = new Date(iso);
      if (Number.isNaN(openAtInstant.getTime())) throw new Error("invalid_open_at");
    } else {
      openAtWall = new Date(iso + "Z");
      if (Number.isNaN(openAtWall.getTime())) throw new Error("invalid_open_at");
    }
  }
  const limit = Math.min(f.limit ?? config.mcp.searchPageSizeDefault, config.mcp.searchPageSizeMax);
  const offset = f.offset ?? 0;

  // Fast path: no JS-side filtering/ordering needed → count + page entirely in
  // SQL; only the returned page (≤ searchPageSizeMax rows) is materialized.
  if (!f.near && !f.open_at) {
    const total = (db.prepare(`SELECT COUNT(*) c FROM merchants WHERE ${whereSql}`).get(...params) as Row).c as number;
    const rows = db
      .prepare(`SELECT * FROM merchants WHERE ${whereSql} ORDER BY merchant_id LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Row[];
    return {
      order: "merchant_id",
      total,
      results: rows.map((row) => searchResultItem(rowToMerchant(row))),
    };
  }

  const rows = db.prepare(`SELECT * FROM merchants WHERE ${whereSql}`).all(...params) as Row[];

  let items = rows
    .map((row) => {
      const m = rowToMerchant(row);
      const distance_km = f.near
        ? haversineKm(f.near.lat, f.near.lng, m.location.lat, m.location.lng)
        : undefined;
      return { m, distance_km };
    })
    .filter(({ m, distance_km }) => {
      if (m.opt_out) return false; // opted-out merchants are retained but never served for discovery
      if (f.neighborhood && m.location.neighborhood.toLowerCase() !== f.neighborhood.toLowerCase())
        return false;
      if (f.near && (distance_km as number) > f.near.radius_km) return false;
      if (
        f.cuisine_tags?.length &&
        !f.cuisine_tags.some((t) => m.cuisine_tags.includes(t.toLowerCase()))
      )
        return false;
      if (
        f.attribute_tags?.length &&
        !f.attribute_tags.every((t) => m.attribute_tags.includes(t.toLowerCase()))
      )
        return false;
      if (f.price_band_min && m.price_band < f.price_band_min) return false;
      if (f.price_band_max && m.price_band > f.price_band_max) return false;
      if (f.bookable_only && !m.bookable) return false;
      if (f.party_size && m.max_party_size < f.party_size) return false;
      if (openAtWall && !isOpenAt(m.hours, m.holiday_exceptions, openAtWall)) return false;
      if (
        openAtInstant &&
        !isOpenAt(m.hours, m.holiday_exceptions, toZoneWallClock(openAtInstant, m.timezone ?? config.timezone))
      )
        return false;
      return true;
    });

  const order = f.order_by === "distance" && f.near ? "distance" : "merchant_id";
  items.sort((a, b) => {
    if (order === "distance") {
      const d = (a.distance_km as number) - (b.distance_km as number);
      if (d !== 0) return d;
    }
    return a.m.merchant_id < b.m.merchant_id ? -1 : 1;
  });

  const total = items.length;
  const page = items.slice(offset, offset + limit);

  return {
    order,
    total,
    results: page.map(({ m, distance_km }) => searchResultItem(m, distance_km)),
  };
}

function searchResultItem(m: Merchant, distance_km?: number): SearchResultItem {
  return {
    merchant_id: m.merchant_id,
    name: m.name,
    cuisine_tags: m.cuisine_tags,
    attribute_tags: m.attribute_tags,
    neighborhood: m.location.neighborhood,
    address: m.location.address,
    timezone: m.timezone,
    lat: m.location.lat,
    lng: m.location.lng,
    price_band: m.price_band,
    reservation_policy: m.reservation_policy,
    bookable: m.bookable,
    verification_status: m.verification_status,
    ...(distance_km !== undefined ? { distance_km: Math.round(distance_km * 100) / 100 } : {}),
  };
}

export function feedbackSummary(db: Database, merchantId: string): FeedbackSummary {
  const rows = db
    .prepare("SELECT * FROM feedback_events WHERE merchant_id = ?")
    .all(merchantId) as Row[];
  const pct = (field: string) => {
    const known = rows.filter((r) => r[field] !== null);
    if (!known.length) return null;
    return Math.round((known.filter((r) => r[field] === 1).length / known.length) * 1000) / 10;
  };
  return {
    count: rows.length,
    reservation_honored_pct: pct("reservation_honored"),
    seated_on_time_pct: pct("seated_on_time"),
    matched_description_pct: pct("matched_description"),
    would_repeat_pct: pct("would_repeat"),
  };
}

/** Platform-observed stats from platform transactions only (REQ-FBK-4) — separate from user feedback. */
export function operationalStats(db: Database, merchantId: string): OperationalStats {
  const bookings = db
    .prepare(
      "SELECT * FROM bookings WHERE merchant_id = ? AND state IN ('confirmed','failed')",
    )
    .all(merchantId) as Row[];
  const confirmed = bookings.filter((b) => b.state === "confirmed");
  const calls = db
    .prepare("SELECT * FROM call_attempts WHERE booking_id IN (SELECT booking_id FROM bookings WHERE merchant_id = ?) AND outcome IS NOT NULL")
    .all(merchantId) as Row[];
  const answered = calls.filter((c) => c.outcome !== "no_answer");

  const confirmMinutes = confirmed
    .map((b) => {
      const done = db
        .prepare(
          "SELECT at FROM booking_events WHERE booking_id = ? AND to_state = 'confirmed' ORDER BY id DESC LIMIT 1",
        )
        .get(b.booking_id) as Row | undefined;
      return done ? (new Date(done.at).getTime() - new Date(b.created_at).getTime()) / 60000 : null;
    })
    .filter((v): v is number => v !== null);

  const noShows = db
    .prepare(
      "SELECT COUNT(*) c FROM feedback_events WHERE merchant_id = ? AND reservation_honored = 1 AND seated_on_time IS NULL",
    )
    .get(merchantId) as Row;

  return {
    bookings_attempted: bookings.length,
    bookings_confirmed: confirmed.length,
    booking_success_rate: bookings.length
      ? Math.round((confirmed.length / bookings.length) * 1000) / 10
      : null,
    avg_confirmation_minutes: confirmMinutes.length
      ? Math.round((confirmMinutes.reduce((a, b) => a + b, 0) / confirmMinutes.length) * 10) / 10
      : null,
    call_answer_rate: calls.length
      ? Math.round((answered.length / calls.length) * 1000) / 10
      : null,
    no_show_reports: noShows.c ?? 0,
  };
}

export function getProvenance(db: Database, merchantId: string) {
  return db
    .prepare(
      "SELECT field, source, detail, recorded_at FROM provenance WHERE merchant_id = ? ORDER BY recorded_at DESC",
    )
    .all(merchantId);
}

export function addProvenance(
  db: Database,
  merchantId: string,
  field: string,
  source: string,
  detail?: string,
) {
  db.prepare(
    "INSERT INTO provenance (merchant_id, field, source, detail, recorded_at) VALUES (?,?,?,?,?)",
  ).run(merchantId, field, source, detail ?? null, now());
}

/** Ops edit with provenance (REQ-OPS-3). Only whitelisted fields are editable. */
const EDITABLE_FIELDS = new Set([
  "name",
  "phone_primary",
  "address",
  "neighborhood",
  "price_band",
  "reservation_policy",
  "requires_deposit",
  "fulfillment_channel",
  "hours",
  "holiday_exceptions",
  "cuisine_tags",
  "attribute_tags",
  "max_party_size",
]);

export function updateMerchantField(
  db: Database,
  merchantId: string,
  field: string,
  value: unknown,
  source: string,
  detail?: string,
) {
  if (!EDITABLE_FIELDS.has(field)) throw new Error(`Field not editable: ${field}`);
  const stored =
    typeof value === "object" ? JSON.stringify(value) : typeof value === "boolean" ? (value ? 1 : 0) : value;
  db.prepare(`UPDATE merchants SET ${field} = ?, updated_at = ? WHERE merchant_id = ?`).run(
    stored,
    now(),
    merchantId,
  );
  addProvenance(db, merchantId, field, source, detail);
}

/** Record a completed verification call: refreshes phone_verified_at and status (REQ-ING-2/3). */
export function recordVerification(
  db: Database,
  merchantId: string,
  operator: string,
  outcome: "verified" | "no_answer" | "wrong_number" | "closed_permanently" | "opted_out",
  notes?: string,
) {
  const at = now();
  db.prepare(
    "INSERT INTO verification_calls (merchant_id, called_at, operator, outcome, notes) VALUES (?,?,?,?,?)",
  ).run(merchantId, at, operator, outcome, notes ?? null);

  if (outcome === "verified") {
    db.prepare(
      "UPDATE merchants SET phone_verified_at = ?, verification_status = CASE verification_status WHEN 'transaction_verified' THEN 'transaction_verified' ELSE 'phone_verified' END, updated_at = ? WHERE merchant_id = ?",
    ).run(at, at, merchantId);
    addProvenance(db, merchantId, "phone_primary", "verification_call", `operator=${operator}`);
    addProvenance(db, merchantId, "hours", "verification_call", `operator=${operator}`);
  } else if (outcome === "opted_out") {
    setOptOut(db, merchantId, notes ?? "requested during verification call");
  } else if (outcome === "closed_permanently") {
    updateMerchantField(db, merchantId, "reservation_policy", "walk_in_only", "verification_call", "closed permanently");
    db.prepare("UPDATE merchants SET phone_verified_at = NULL, updated_at = ? WHERE merchant_id = ?").run(at, merchantId);
  }
}

/** REQ-ING-4: opt-out is set same-day, hard-excludes from booking, record retained. */
export function setOptOut(db: Database, merchantId: string, notes?: string) {
  const at = now();
  db.prepare(
    "UPDATE merchants SET opt_out = 1, opt_out_at = ?, updated_at = ? WHERE merchant_id = ?",
  ).run(at, at, merchantId);
  db.prepare(
    "INSERT INTO complaints (merchant_id, kind, notes, opened_at, resolved_at, resolution) VALUES (?,?,?,?,?,?)",
  ).run(merchantId, "opt_out_request", notes ?? null, at, at, "opt_out set");
  addProvenance(db, merchantId, "opt_out", "merchant_request", notes);
}

/** REQ-FUL-9: merchant expressing annoyance twice is auto-flagged for human_call routing. */
export function recordAnnoyance(db: Database, merchantId: string, note: string) {
  const row = db
    .prepare("UPDATE merchants SET annoyance_count = annoyance_count + 1, updated_at = ? WHERE merchant_id = ? RETURNING annoyance_count")
    .get(now(), merchantId) as Row;
  if (row && row.annoyance_count >= 2) {
    db.prepare(
      "UPDATE merchants SET fulfillment_channel = 'human_call', human_call_flag_reason = ? WHERE merchant_id = ?",
    ).run(`auto-flagged after ${row.annoyance_count} annoyance signals: ${note}`, merchantId);
  }
}

/**
 * Merchants due for (re-)verification (REQ-ING-3): never-verified and
 * stale-verified under the 60-day policy, plus change-signal pulls — a verified
 * merchant whose source phone now disagrees enters the queue immediately (ahead
 * of everything else) regardless of verification age.
 */
export function verificationQueue(db: Database) {
  const cutoff = new Date(Date.now() - config.registry.freshnessDays * 86400_000).toISOString();
  return db
    .prepare(
      `SELECT merchant_id, name, neighborhood, phone_primary, phone_verified_at, verification_status,
              source_phone_conflict, source_phone_conflict_at
       FROM merchants
       WHERE opt_out = 0 AND (phone_verified_at IS NULL OR phone_verified_at < ? OR source_phone_conflict IS NOT NULL)
       ORDER BY source_phone_conflict IS NULL, phone_verified_at IS NOT NULL, phone_verified_at ASC, merchant_id`,
    )
    .all(cutoff);
}

/**
 * P2 freshness block for get_registry_meta, derived from the import ledger and
 * change-aware updated_at stamps. Honest emptiness: a database imported before
 * the ledger existed reports releases: [] until its next import.
 */
function dataFreshness(db: Database) {
  const dayMs = 86400_000;
  const releases = (
    db
      .prepare(
        `SELECT city_key, city, release, generated_at, imported_at, merchant_count, manifest_json
         FROM imports i WHERE id = (SELECT MAX(id) FROM imports WHERE city_key = i.city_key)
         ORDER BY city_key`,
      )
      .all() as Row[]
  ).map((r) => {
    const manifest = JSON.parse(r.manifest_json as string) as {
      field_coverage?: Record<string, number>;
      diff_vs_previous?: { added: number; removed: number; changed: number; unchanged: number } | null;
    };
    const diff = manifest.diff_vs_previous ?? null;
    return {
      city: r.city,
      city_key: r.city_key,
      release: r.release,
      generated_at: r.generated_at,
      imported_at: r.imported_at,
      merchant_count: r.merchant_count,
      source_data_age_days: Math.max(
        0,
        Math.floor((Date.now() - Date.parse(`${r.generated_at}T00:00:00Z`)) / dayMs),
      ),
      field_coverage: manifest.field_coverage ?? null,
      churn_vs_previous_release: diff
        ? { added: diff.added, removed: diff.removed, changed: diff.changed, unchanged: diff.unchanged }
        : null,
    };
  });

  // Record age = days since a served field of the record last changed
  // (change-aware imports; unchanged re-imports don't touch updated_at).
  const total = (db.prepare("SELECT COUNT(*) c FROM merchants WHERE sandbox = 0 AND opt_out = 0").get() as Row)
    .c as number;
  const ageAt = (fraction: number): number | null => {
    if (!total) return null;
    const row = db
      .prepare(
        `SELECT updated_at FROM merchants WHERE sandbox = 0 AND opt_out = 0
         ORDER BY updated_at DESC LIMIT 1 OFFSET ?`,
      )
      .get(Math.min(total - 1, Math.floor(fraction * (total - 1)))) as Row | undefined;
    if (!row?.updated_at) return null;
    return Math.max(0, Math.floor((Date.now() - Date.parse(row.updated_at as string)) / dayMs));
  };

  return {
    releases,
    record_age_days: { p50: ageAt(0.5), p90: ageAt(0.9) },
    source_phone_conflicts: (
      db.prepare("SELECT COUNT(*) c FROM merchants WHERE source_phone_conflict IS NOT NULL").get() as Row
    ).c,
    note: "updated_at moves only when source data for a record actually changes; record_age_days measures staleness of the served corpus, not import cadence.",
  };
}

export function registryMeta(db: Database) {
  const one = (sql: string) => (db.prepare(sql).get() as Row).c as number;
  const cutoff = new Date(Date.now() - config.registry.freshnessDays * 86400_000).toISOString();
  const merchants = one("SELECT COUNT(*) c FROM merchants");
  const fresh = db
    .prepare("SELECT COUNT(*) c FROM merchants WHERE phone_verified_at >= ?")
    .get(cutoff) as Row;
  return {
    schema_version: config.schemaVersion,
    city: config.launchCity,
    timezone: config.timezone,
    // Per-city coverage with each city's IANA zone — the authoritative
    // multi-city view (the flat city/timezone pair above is the legacy
    // launch-config default, kept for schema stability).
    cities: (
      db
        .prepare(
          "SELECT city, MAX(timezone) tz, COUNT(*) c FROM merchants WHERE sandbox = 0 AND opt_out = 0 GROUP BY city ORDER BY city",
        )
        .all() as Row[]
    ).map((r) => ({ city: r.city, timezone: r.tz ?? null, merchant_count: r.c })),
    merchant_count: merchants,
    sandbox_count: one("SELECT COUNT(*) c FROM merchants WHERE sandbox = 1"),
    real_count: one("SELECT COUNT(*) c FROM merchants WHERE sandbox = 0"),
    bookable_count: one(
      "SELECT COUNT(*) c FROM merchants WHERE phone_verified_at IS NOT NULL AND opt_out = 0 AND requires_deposit = 0 AND reservation_policy IN ('phone_reservations','accepts_reservations')",
    ),
    verification: {
      phone_verified: one("SELECT COUNT(*) c FROM merchants WHERE verification_status = 'phone_verified'"),
      transaction_verified: one(
        "SELECT COUNT(*) c FROM merchants WHERE verification_status = 'transaction_verified'",
      ),
      unverified: one("SELECT COUNT(*) c FROM merchants WHERE verification_status = 'unverified'"),
    },
    freshness: {
      policy_days: config.registry.freshnessDays,
      verified_within_policy: fresh.c,
      verified_within_policy_pct: merchants
        ? Math.round(((fresh.c as number) / merchants) * 1000) / 10
        : 0,
    },
    // P2 freshness: which release each city's served corpus came from, how old
    // that source data is, and what churned vs the prior release — so an agent
    // can decide trust/re-fetch/cache without sampling records (REQ-MCP-1).
    data: dataFreshness(db),
    opted_out: one("SELECT COUNT(*) c FROM merchants WHERE opt_out = 1"),
    bookings: {
      total: one("SELECT COUNT(*) c FROM bookings"),
      confirmed: one("SELECT COUNT(*) c FROM bookings WHERE state = 'confirmed'"),
    },
    feedback_events: one("SELECT COUNT(*) c FROM feedback_events"),
    availability_check: "performed_at_booking",
    booking_policy:
      "Sandbox merchants (sandbox:true) are bookable end-to-end for integration testing. Real merchants are discovery-only: place_booking returns fulfillment_not_live until human-operator fulfillment launches.",
    fulfillment: {
      live_channels: config.fulfillment.liveChannels,
      human_call: {
        live: config.fulfillment.liveChannels.includes("human_call"),
        operator: "human",
        operator_window: `${config.fulfillment.operatorWindow.start}–${config.fulfillment.operatorWindow.end} ${config.fulfillment.operatorWindow.timezone}`,
        sla_hours: Math.round((config.fulfillment.channelSlaMs.human_call / 3600_000) * 10) / 10,
        note: "human_call bookings are fulfilled by a human operator phoning the merchant. They queue until worked — expect resolution within the operator window, with an honest auto-fail (expired_sla) at the SLA.",
      },
    },
    ordering_rule:
      "search_merchants returns deterministic order: merchant_id ASC by default, distance ASC (ties by merchant_id) when geo filter present. The registry never ranks.",
  };
}
