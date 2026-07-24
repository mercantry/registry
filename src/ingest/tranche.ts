/**
 * Pilot-tranche nomination (note 004): rank a release's merchants by
 * data-quality signals and emit candidates for the operator's human
 * verification pass. Nominates, never decides — the tranche pick (which
 * neighborhood, how many) is the operator's call.
 *
 *   tsx src/ingest/tranche.ts --release data/releases/2026-07-16-la [--size 50] [--neighborhood "Silver Lake"]
 *
 * Scoring is quality-signal-only (REQ-DATA-2 applies to what we SERVE; this is
 * an internal ops work-list, never exposed via the MCP): official-register
 * match is worth most (a government record says this business exists), then
 * phone + website presence, then neighborhood attribution. Ties break on
 * merchant_id so the list is deterministic.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReleaseManifest, ReleaseMerchant } from "./types.js";

// Keys as the connectors emit them ("tokyo_opendata" — fixed 07-23; the old
// "tokyo_open_data" meant Tokyo candidates never scored their register match).
export const OFFICIAL_SOURCES = new Set(["fehd_hk", "la_open_data", "tokyo_opendata"]);

export interface TrancheCandidate {
  merchant_id: string;
  name: string;
  phone: string;
  address: string;
  neighborhood: string;
  timezone: string;
  score: number;
  signals: string[];
}

export interface TranchePacket {
  city: string;
  generated_from: string;
  criteria: string;
  neighborhood_filter: string | null;
  candidate_count: number;
  top_neighborhoods: { neighborhood: string; candidates: number }[];
  candidates: TrancheCandidate[];
}

export function nominateTranche(
  manifest: ReleaseManifest,
  merchants: ReleaseMerchant[],
  opts: { size: number; neighborhood?: string },
): TranchePacket {
  const scored: TrancheCandidate[] = [];
  for (const m of merchants) {
    if (!m.phone_primary) continue; // operator needs a number to dial
    if (opts.neighborhood && m.location.neighborhood.toLowerCase() !== opts.neighborhood.toLowerCase()) continue;

    const signals: string[] = [];
    let score = 0;
    if (m.source_provenance.some((p) => OFFICIAL_SOURCES.has(p.source))) {
      score += 4;
      signals.push("official_register_match");
    }
    score += 2;
    signals.push("phone_present");
    if (m.website) {
      score += 1;
      signals.push("website_present");
    }
    if (m.location.neighborhood) {
      score += 1;
      signals.push("neighborhood_attributed");
    }

    scored.push({
      merchant_id: m.merchant_id,
      name: m.name,
      phone: m.phone_primary,
      address: m.location.address,
      neighborhood: m.location.neighborhood,
      timezone: m.timezone,
      score,
      signals,
    });
  }

  scored.sort((a, b) => b.score - a.score || a.merchant_id.localeCompare(b.merchant_id));
  const candidates = scored.slice(0, opts.size);

  const byHood = new Map<string, number>();
  for (const c of candidates) {
    const key = c.neighborhood || "(unattributed)";
    byHood.set(key, (byHood.get(key) ?? 0) + 1);
  }

  return {
    city: manifest.city,
    generated_from: manifest.release,
    criteria:
      "phone required; scored: official register match (4) + phone (2) + website (1) + neighborhood (1); deterministic tie-break on merchant_id",
    neighborhood_filter: opts.neighborhood ?? null,
    candidate_count: candidates.length,
    top_neighborhoods: [...byHood.entries()]
      .map(([neighborhood, count]) => ({ neighborhood, candidates: count }))
      .sort((a, b) => b.candidates - a.candidates || a.neighborhood.localeCompare(b.neighborhood)),
    candidates,
  };
}

export async function loadRelease(releaseDir: string): Promise<{ manifest: ReleaseManifest; merchants: ReleaseMerchant[] }> {
  const manifest = JSON.parse(await readFile(join(releaseDir, "manifest.json"), "utf8")) as ReleaseManifest;
  const ndjson = await readFile(join(releaseDir, manifest.ndjson_file), "utf8");
  const merchants = ndjson
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ReleaseMerchant);
  return { manifest, merchants };
}

function parseArgs(argv: string[]) {
  const args: { release?: string; size: number; neighborhood?: string; out?: string } = { size: 50 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--release") args.release = argv[++i];
    else if (argv[i] === "--size") args.size = Number(argv[++i]);
    else if (argv[i] === "--neighborhood") args.neighborhood = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!args.release) throw new Error("--release <dir> is required");
  if (!Number.isFinite(args.size) || args.size < 1) throw new Error("--size must be a positive number");
  return args;
}

if (process.argv[1] && process.argv[1].endsWith("tranche.ts")) {
  const args = parseArgs(process.argv.slice(2));
  loadRelease(args.release!)
    .then(({ manifest, merchants }) => {
      const packet = nominateTranche(manifest, merchants, { size: args.size, neighborhood: args.neighborhood });
      const json = JSON.stringify(packet, null, 2);
      return args.out ? writeFile(args.out, json + "\n", "utf8").then(() => console.log(`written: ${args.out}`)) : console.log(json);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
