export type ReservationPolicy =
  | "walk_in_only"
  | "phone_reservations"
  | "accepts_reservations"
  | "requires_deposit";

export type FulfillmentChannel = "native_mcp" | "api_bridge" | "voice_agent" | "human_call";

export type VerificationStatus = "unverified" | "phone_verified" | "transaction_verified";

export interface HoursBlock {
  day: number; // 0 = Sunday .. 6 = Saturday
  open: string; // "HH:MM"
  close: string; // "HH:MM" — close < open means service past midnight
}

export interface HolidayException {
  date: string; // YYYY-MM-DD
  closed: boolean;
  open?: string;
  close?: string;
}

export interface Merchant {
  merchant_id: string;
  name: string;
  aliases: string[];
  category: string;
  cuisine_tags: string[];
  attribute_tags: string[];
  location: {
    address: string;
    neighborhood: string;
    city: string;
    lat: number;
    lng: number;
  };
  /** IANA timezone (e.g. "Asia/Tokyo"). Naive booking datetimes and open_at are interpreted in it. */
  timezone: string | null;
  phone_primary: string | null;
  phone_verified_at: string | null;
  hours: HoursBlock[];
  holiday_exceptions: HolidayException[];
  price_band: number;
  reservation_policy: ReservationPolicy;
  requires_deposit: boolean;
  /** Derived: phone-verified AND accepts phone reservations AND not opted out AND no deposit required. */
  bookable: boolean;
  fulfillment_channel: FulfillmentChannel;
  languages: string[];
  verification_status: VerificationStatus;
  opt_out: boolean;
  /** Booking guard (note 004): sandbox merchants are safe to dial via voiceSim ("Stripe test cards for bookings"). Real merchants are discovery-only until human-operator fulfillment is live. */
  sandbox: boolean;
  max_party_size: number;
  created_at: string;
  updated_at: string;
}

export interface FeedbackSummary {
  count: number;
  reservation_honored_pct: number | null;
  seated_on_time_pct: number | null;
  matched_description_pct: number | null;
  would_repeat_pct: number | null;
}

export interface OperationalStats {
  bookings_attempted: number;
  bookings_confirmed: number;
  booking_success_rate: number | null;
  avg_confirmation_minutes: number | null;
  call_answer_rate: number | null;
  no_show_reports: number;
}

export type BookingState =
  | "pending"
  | "queued"
  | "in_progress"
  | "needs_input"
  | "confirmed"
  | "failed"
  | "cancelled";

export type FailureReason =
  | "no_answer"
  | "fully_booked"
  | "closed"
  | "policy_mismatch"
  | "merchant_declined"
  | "bad_data"
  | "expired_sla"
  | "needs_input_timeout";

export const TERMINAL_STATES: BookingState[] = ["confirmed", "failed", "cancelled"];

export interface SearchFilters {
  neighborhood?: string;
  near?: { lat: number; lng: number; radius_km: number };
  cuisine_tags?: string[];
  attribute_tags?: string[];
  price_band_min?: number;
  price_band_max?: number;
  /** ISO-8601 datetime. Explicit offset = exact instant (evaluated per merchant zone); naive = each merchant's local wall clock. */
  open_at?: string;
  bookable_only?: boolean;
  party_size?: number;
  /** Deterministic ordering (documented, REQ non-ranking): "merchant_id" | "distance" (distance requires `near`). */
  order_by?: "merchant_id" | "distance";
  limit?: number;
  offset?: number;
}
