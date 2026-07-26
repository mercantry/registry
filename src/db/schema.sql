-- Registry v1 schema (schema_version 1.0.0)
-- Design principle: raw signals only. No ranking fields, no platform-authored scores (REQ-DATA-2).

CREATE TABLE IF NOT EXISTS merchants (
  merchant_id        TEXT PRIMARY KEY,               -- stable UUID
  name               TEXT NOT NULL,
  aliases            TEXT NOT NULL DEFAULT '[]',     -- JSON array; includes local-language name slot (unpopulated in v1)
  category           TEXT NOT NULL DEFAULT 'restaurant',
  cuisine_tags       TEXT NOT NULL DEFAULT '[]',     -- JSON array
  attribute_tags     TEXT NOT NULL DEFAULT '[]',     -- JSON array (outdoor_seating, vegetarian_friendly, ...)
  address            TEXT NOT NULL,
  neighborhood       TEXT NOT NULL,
  city               TEXT NOT NULL,
  timezone           TEXT,                           -- IANA zone (e.g. Asia/Tokyo); naive booking datetimes are merchant-local
  lat                REAL NOT NULL,
  lng                REAL NOT NULL,
  website            TEXT,                           -- merchant's own site, release-sourced; absent stays absent (never fabricated)
  phone_primary      TEXT,
  phone_verified_at  TEXT,                           -- ISO timestamp; required for bookable
  source_phone_conflict TEXT,                        -- P2 freshness: source phone that disagrees with the verified phone (re-verification signal, REQ-ING-3)
  source_phone_conflict_at TEXT,                     -- when the conflicting value was first observed
  verified_field_change TEXT,                        -- P2 freshness: JSON array of served fields (name|address|geo|website) that changed since verification — applied, unlike phone, but flagged for re-verification; cleared when the operator re-verifies
  verified_field_change_at TEXT,                     -- when the first such change was observed
  hours              TEXT NOT NULL DEFAULT '[]',     -- JSON: [{day:0-6, open:"HH:MM", close:"HH:MM"}]
  holiday_exceptions TEXT NOT NULL DEFAULT '[]',     -- JSON: [{date:"YYYY-MM-DD", closed:bool, open?, close?}]
  price_band         INTEGER NOT NULL DEFAULT 2,     -- 1..4
  reservation_policy TEXT NOT NULL DEFAULT 'accepts_reservations',
                     -- walk_in_only | phone_reservations | accepts_reservations | requires_deposit
  requires_deposit   INTEGER NOT NULL DEFAULT 0,
  fulfillment_channel TEXT NOT NULL DEFAULT 'voice_agent',
                     -- native_mcp | api_bridge | voice_agent | human_call (v1 populates only the last two)
  languages          TEXT NOT NULL DEFAULT '[]',     -- unpopulated in v1
  verification_status TEXT NOT NULL DEFAULT 'unverified',
                     -- unverified | phone_verified | transaction_verified
  opt_out            INTEGER NOT NULL DEFAULT 0,
  opt_out_at         TEXT,
  sandbox            INTEGER NOT NULL DEFAULT 0,     -- booking guard: only sandbox merchants may be dialed by voiceSim (note 004). Real imported merchants default 0 → discovery-only.
  human_call_flag_reason TEXT,                       -- why routed to human_call (REQ-FUL-2/9)
  annoyance_count    INTEGER NOT NULL DEFAULT 0,     -- REQ-FUL-9: two strikes -> human_call routing
  max_party_size     INTEGER NOT NULL DEFAULT 8,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_merchants_neighborhood ON merchants(neighborhood);
CREATE INDEX IF NOT EXISTS idx_merchants_geo ON merchants(lat, lng);

-- Per-field provenance (REQ-ING-1): where each field came from, with timestamps.
CREATE TABLE IF NOT EXISTS provenance (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id TEXT NOT NULL REFERENCES merchants(merchant_id),
  field       TEXT NOT NULL,
  source      TEXT NOT NULL,      -- e.g. public_listing | merchant_website | verification_call | ops_edit
  detail      TEXT,               -- free text: URL, call id, operator note
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_provenance_merchant ON provenance(merchant_id);

-- Verification calls (REQ-ING-2/3); doubles as the ops training log.
CREATE TABLE IF NOT EXISTS verification_calls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id   TEXT NOT NULL REFERENCES merchants(merchant_id),
  called_at     TEXT NOT NULL,
  operator      TEXT NOT NULL,
  outcome       TEXT NOT NULL,     -- verified | no_answer | wrong_number | closed_permanently | opted_out
  notes         TEXT
);

CREATE TABLE IF NOT EXISTS bookings (
  booking_id       TEXT PRIMARY KEY,
  merchant_id      TEXT NOT NULL REFERENCES merchants(merchant_id),
  api_key_id       TEXT,                    -- issuing agent developer (abuse control + no-show tracking)
  state            TEXT NOT NULL,           -- pending|queued|in_progress|needs_input|confirmed|failed|cancelled
  failure_reason   TEXT,                    -- no_answer|fully_booked|closed|policy_mismatch|merchant_declined|bad_data|expired_sla|needs_input_timeout
  party_size       INTEGER NOT NULL,
  requested_time   TEXT NOT NULL,           -- ISO local datetime
  window_minutes   INTEGER NOT NULL DEFAULT 0,   -- acceptable +/- window
  accept_within_window INTEGER NOT NULL DEFAULT 0,
  confirmed_time   TEXT,
  reservation_name TEXT NOT NULL,           -- end-human PII: stored only for the booking (privacy NFR)
  contact          TEXT,                    -- optional phone/email for confirmation relay
  special_requests TEXT,
  callback_url     TEXT,                    -- REQ-MCP-3 webhook target for state changes
  needs_input_options TEXT,                 -- JSON: structured options offered by merchant
  needs_input_deadline TEXT,
  merchant_instructions TEXT,
  confirmation_code TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TEXT,                    -- retry scheduling (REQ-FUL-6)
  sla_deadline     TEXT NOT NULL,           -- terminal state due by (REQ-FUL-6; per-channel, note 004)
  notify_issue_number INTEGER,              -- note 004: GitHub issue notifying the operator (NULL = none yet)
  notify_issue_closed INTEGER NOT NULL DEFAULT 0,  -- note 004: issue closed on terminal state
  client_reference_id TEXT,                 -- agent-supplied idempotency key: retried place_booking returns this row
  request_fingerprint TEXT,                 -- hash of the original request; a replay must match or is rejected
  sandbox_outcome  TEXT,                    -- sandbox merchants only: caller-forced simulated call result (NULL = drawn)
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_state ON bookings(state);
CREATE INDEX IF NOT EXISTS idx_bookings_merchant ON bookings(merchant_id);

-- Full audit log: every transition timestamped (REQ-FUL-1, auditability NFR).
CREATE TABLE IF NOT EXISTS booking_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id  TEXT NOT NULL REFERENCES bookings(booking_id),
  at          TEXT NOT NULL,
  event       TEXT NOT NULL,      -- state_change | tool_call | call_note | webhook_sent | ...
  from_state  TEXT,
  to_state    TEXT,
  detail      TEXT,               -- JSON payload
  dispatched  INTEGER NOT NULL DEFAULT 0   -- webhook dispatcher cursor (REQ-MCP-3)
);
CREATE INDEX IF NOT EXISTS idx_events_booking ON booking_events(booking_id);

CREATE TABLE IF NOT EXISTS call_attempts (
  call_id     TEXT PRIMARY KEY,
  booking_id  TEXT NOT NULL REFERENCES bookings(booking_id),
  attempt_no  INTEGER NOT NULL,
  channel     TEXT NOT NULL,      -- voice_agent | human_call
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  outcome     TEXT,               -- confirmed | no_answer | fully_booked | closed | policy_mismatch | merchant_declined | bad_data | counter_offer | handed_off
  taken_over  INTEGER NOT NULL DEFAULT 0,   -- human takeover happened (containment metric, REQ-OPS-4)
  operator    TEXT,
  disposition_code TEXT,
  transcript  TEXT NOT NULL DEFAULT '[]'    -- JSON array of {at, speaker, text} (live-monitorable, REQ-FUL-4)
);
CREATE INDEX IF NOT EXISTS idx_calls_booking ON call_attempts(booking_id);

-- Agent feedback (REQ-FBK-1/2): only vs confirmed bookings, once, within 14 days.
CREATE TABLE IF NOT EXISTS feedback_events (
  feedback_id   TEXT PRIMARY KEY,
  booking_id    TEXT NOT NULL UNIQUE REFERENCES bookings(booking_id),
  merchant_id   TEXT NOT NULL REFERENCES merchants(merchant_id),
  submitted_at  TEXT NOT NULL,
  reservation_honored INTEGER NOT NULL,
  seated_on_time      INTEGER,
  matched_description INTEGER,
  would_repeat        INTEGER,
  free_text     TEXT
);
CREATE INDEX IF NOT EXISTS idx_feedback_merchant ON feedback_events(merchant_id);

-- REQ-MCP-4: self-serve API keys per agent developer.
CREATE TABLE IF NOT EXISTS api_keys (
  key_id         TEXT PRIMARY KEY,
  api_key        TEXT NOT NULL UNIQUE,
  developer_name TEXT NOT NULL,
  contact        TEXT NOT NULL,
  webhook_url    TEXT,
  created_ip     TEXT,                          -- Gate B: per-IP mint limits

  no_show_count  INTEGER NOT NULL DEFAULT 0,   -- risk: high no-show developers get throttled
  throttled      INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);

-- P2 freshness: one row per release import — which release each city's served
-- corpus came from and when. registry_meta reads the latest row per city;
-- older rows stay as the import audit trail. manifest_json carries the full
-- release manifest (field coverage, diff_vs_previous, source_agreement).
CREATE TABLE IF NOT EXISTS imports (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  city_key        TEXT NOT NULL,     -- ingestion city key (la | tokyo | hk | sh)
  city            TEXT NOT NULL,
  release         TEXT NOT NULL,     -- e.g. 2026-07-22-hk
  generated_at    TEXT NOT NULL,     -- release data date (source snapshot age starts here)
  imported_at     TEXT NOT NULL,     -- when the import ran against this database
  checksum_sha256 TEXT NOT NULL,
  merchant_count  INTEGER NOT NULL,  -- records in the release
  inserted        INTEGER NOT NULL,
  updated         INTEGER NOT NULL,  -- rows whose served fields actually changed
  unchanged       INTEGER NOT NULL,
  phone_conflicts INTEGER NOT NULL,  -- verified merchants whose source phone disagrees (open conflicts after this import)
  field_changes   INTEGER NOT NULL DEFAULT 0,  -- verified merchants with an open name/address/geo change signal after this import
  manifest_json   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_imports_city ON imports(city_key, id);

-- Ops complaint / opt-out workflow (REQ-OPS-5) with same-day SLA.
CREATE TABLE IF NOT EXISTS complaints (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id  TEXT NOT NULL REFERENCES merchants(merchant_id),
  kind         TEXT NOT NULL,        -- complaint | opt_out_request
  notes        TEXT,
  opened_at    TEXT NOT NULL,
  resolved_at  TEXT,
  resolution   TEXT
);
