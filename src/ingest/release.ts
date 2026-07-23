/**
 * Versioned data releases: merchants.ndjson + manifest.json. The release —
 * not the database — is the unit of review, diffing, and rollback
 * — NDJSON is sorted by merchant_id upstream, so
 * releases diff cleanly and checksums are reproducible.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CityConfig, ReleaseManifest, ReleaseMerchant, SourceStats } from "./types.js";
import { sha256Hex } from "./normalize.js";
import { UNSOURCED_DEFAULTS, type CrosscheckStats } from "./conflate.js";
import type { ValidationReport } from "./validate.js";

export interface WriteReleaseOptions {
  outDir: string;
  stamp: string;
  city: CityConfig;
  merchants: ReleaseMerchant[];
  sources: SourceStats[];
  crosscheck: CrosscheckStats | null;
  dropped: ReleaseManifest["dropped"];
  report: ValidationReport;
}

export async function writeRelease(opts: WriteReleaseOptions): Promise<{ dir: string; manifest: ReleaseManifest }> {
  const releaseId = `${opts.stamp}-${opts.city.key}`;
  const dir = join(opts.outDir, releaseId);
  await mkdir(dir, { recursive: true });

  const ndjson = opts.merchants.map((m) => JSON.stringify(m)).join("\n") + "\n";
  const manifest: ReleaseManifest = {
    release: releaseId,
    city: opts.city.city,
    city_key: opts.city.key,
    generated_at: opts.stamp,
    merchant_count: opts.merchants.length,
    sources: opts.sources,
    field_coverage: opts.report.field_coverage,
    official_crosscheck: opts.crosscheck,
    unsourced_defaults: UNSOURCED_DEFAULTS,
    dropped: opts.dropped,
    checksum_sha256: sha256Hex(ndjson),
    ndjson_file: "merchants.ndjson",
  };

  await writeFile(join(dir, "merchants.ndjson"), ndjson, "utf8");
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  if (opts.report.warnings.length > 0) {
    await writeFile(join(dir, "warnings.txt"), opts.report.warnings.join("\n") + "\n", "utf8");
  }
  return { dir, manifest };
}
