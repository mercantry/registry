/**
 * Per-city release QA (P1 exit / discovery-only cutover condition (a)).
 *
 *   tsx src/ingest/qa.ts --release data/releases/2026-07-17-hk [--probe-websites] [--sample 50] [--out qa.json]
 *
 * Honest scope — what this DOES measure, machine-verifiably:
 *  - GATE (hard pass/fail): zero well-formedness failures in a deterministic
 *    sample — non-empty name, plausible address (contains a number token or a
 *    CJK block), E.164 phone when present, coordinates in-bbox (re-asserted).
 *  - EVIDENCE (reported, not gated): fraction of the sample confirmed by an
 *    official government register (name+address agreement is what matching
 *    established); website liveness for sampled records that carry one
 *    (CI probes; a live site is existence evidence, a dead one a flag).
 *
 * What it does NOT claim: ground-truth field accuracy. That comes from
 * @observer's verification calls (REQ-ING-2) on the pilot tranche. The sampled
 * records are printed for a human/agent read as the final sanity layer.
 *
 * Sampling is deterministic (sorted corpus, fixed stride from the release
 * checksum) so a QA verdict is reproducible from the artifact alone.
 */
import { writeFile } from "node:fs/promises";
import { loadRelease } from "./tranche.js";
import { E164_RE, inBbox } from "./normalize.js";
import { CITIES } from "./cities.js";
import type { CityKey, ReleaseMerchant } from "./types.js";

const OFFICIAL_SOURCES = new Set(["fehd_hk", "la_open_data", "tokyo_open_data", "wikidata"]);

export interface QaReport {
  city: string;
  release: string;
  sample_size: number;
  gate: {
    well_formedness_failures: { merchant_id: string; reason: string }[];
    passed: boolean;
  };
  evidence: {
    register_confirmed: number;
    register_confirmed_rate: number;
    websites_probed: number;
    websites_live: number;
    website_live_rate: number | null;
  };
  methodology: string;
  verdict: "pass" | "fail";
}

export function sampleMerchants(merchants: ReleaseMerchant[], size: number, seedHex: string): ReleaseMerchant[] {
  if (merchants.length <= size) return [...merchants];
  const stride = Math.floor(merchants.length / size);
  // Checksum-derived offset: reproducible from the artifact, varies per release.
  const offset = parseInt(seedHex.slice(0, 8), 16) % stride;
  const sample: ReleaseMerchant[] = [];
  for (let i = offset; i < merchants.length && sample.length < size; i += stride) {
    sample.push(merchants[i]);
  }
  return sample;
}

function wellFormednessFailure(m: ReleaseMerchant, cityKey: CityKey): string | null {
  if (!m.name.trim() || m.name.trim().length < 2) return "name empty/too short";
  if (/^[\p{P}\p{S}\p{N}\s]+$/u.test(m.name)) return "name is only punctuation/digits";
  const addr = m.location.address.trim();
  if (!addr) return "address empty";
  if (!/\d/.test(addr) && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(addr)) {
    return "address has no number token (non-CJK)";
  }
  if (m.phone_primary && !E164_RE.test(m.phone_primary)) return "phone not E.164";
  if (!inBbox(m.location.lat, m.location.lng, CITIES[cityKey].bbox)) return "coordinates out of bbox";
  return null;
}

async function probeWebsite(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      headers: { "user-agent": "mercantry-ingest/0.1 (qa liveness probe)" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok || (res.status >= 300 && res.status < 400)) return true;
    // Some servers reject HEAD; one GET retry before counting a failure.
    if (res.status === 405 || res.status === 403) {
      const get = await fetch(url, {
        headers: { "user-agent": "mercantry-ingest/0.1 (qa liveness probe)" },
        signal: AbortSignal.timeout(10_000),
      });
      return get.ok;
    }
    return false;
  } catch {
    return false;
  }
}

export async function runQa(releaseDir: string, opts: { sample: number; probeWebsites: boolean }): Promise<{ report: QaReport; sample: ReleaseMerchant[] }> {
  const { manifest, merchants } = await loadRelease(releaseDir);
  const sample = sampleMerchants(merchants, opts.sample, manifest.checksum_sha256);

  const failures: { merchant_id: string; reason: string }[] = [];
  let registerConfirmed = 0;
  for (const m of sample) {
    const failure = wellFormednessFailure(m, manifest.city_key);
    if (failure) failures.push({ merchant_id: m.merchant_id, reason: failure });
    if (m.source_provenance.some((p) => OFFICIAL_SOURCES.has(p.source))) registerConfirmed++;
  }

  let probed = 0;
  let live = 0;
  if (opts.probeWebsites) {
    for (const m of sample) {
      if (!m.website) continue;
      probed++;
      if (await probeWebsite(m.website)) live++;
    }
  }

  const report: QaReport = {
    city: manifest.city,
    release: manifest.release,
    sample_size: sample.length,
    gate: { well_formedness_failures: failures, passed: failures.length === 0 },
    evidence: {
      register_confirmed: registerConfirmed,
      register_confirmed_rate: Math.round((registerConfirmed / (sample.length || 1)) * 1000) / 1000,
      websites_probed: probed,
      websites_live: live,
      website_live_rate: probed > 0 ? Math.round((live / probed) * 1000) / 1000 : null,
    },
    methodology:
      "deterministic checksum-seeded sample; gate = zero well-formedness failures; register agreement + website liveness reported as evidence, not gated; ground-truth accuracy deferred to REQ-ING-2 verification calls",
    verdict: failures.length === 0 ? "pass" : "fail",
  };
  return { report, sample };
}

function parseArgs(argv: string[]) {
  const args: { release?: string; sample: number; probeWebsites: boolean; out?: string } = { sample: 50, probeWebsites: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--release") args.release = argv[++i];
    else if (argv[i] === "--sample") args.sample = Number(argv[++i]);
    else if (argv[i] === "--probe-websites") args.probeWebsites = true;
    else if (argv[i] === "--out") args.out = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!args.release) throw new Error("--release <dir> is required");
  if (!Number.isFinite(args.sample) || args.sample < 1) throw new Error("--sample must be positive");
  return args;
}

if (process.argv[1] && process.argv[1].endsWith("qa.ts")) {
  const args = parseArgs(process.argv.slice(2));
  runQa(args.release!, { sample: args.sample, probeWebsites: args.probeWebsites })
    .then(async ({ report, sample }) => {
      const json = JSON.stringify(report, null, 2);
      if (args.out) await writeFile(args.out, json + "\n", "utf8");
      console.log(json);
      // Compact sample listing for the human/agent read layer.
      console.log("QA_SAMPLE_BEGIN");
      for (const m of sample) {
        console.log(`${m.name} | ${m.location.address} | ${m.location.neighborhood} | ${m.phone_primary ?? "-"} | ${m.website ?? "-"}`);
      }
      console.log("QA_SAMPLE_END");
      if (report.verdict === "fail") process.exit(1);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
