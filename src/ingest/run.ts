/**
 * Ingestion CLI — runs one city end to end:
 *   overture geojsonseq → dedupe → official-register enrichment → validate (fail-closed) → release
 *
 * Runs in GitHub Actions (.github/workflows/ingest.yml): interactive sessions
 * in this workspace cannot reach the data portals (egress policy), CI can.
 *
 *   tsx src/ingest/run.ts --city hk --overture tmp/hk.geojsonseq --stamp 2026-07-16
 *   tsx src/ingest/run.ts --city la --print-bbox           # emits the bbox for the CLI extract step
 *
 * --official-file <source>=<path> substitutes a local file for the network
 * fetch (offline runs / fixtures); --skip-official runs base-layer only.
 */
import { readFile } from "node:fs/promises";
import { getCity } from "./cities.js";
import { loadOverture } from "./connectors/overture.js";
import { fetchFehd, parseFehdXml } from "./connectors/fehd.js";
import { fetchLaOpenData, parseSocrataRows } from "./connectors/losangeles.js";
import { fetchTokyoRegister, parseTokyoLicenceCsv } from "./connectors/tokyo.js";
import { fetchWikidataPlaces, parseWikidataResults } from "./connectors/wikidata.js";
import { dedupeStaged, enrichWithOfficial, enrichWithWikidata, toReleaseMerchants, type CrosscheckStats } from "./conflate.js";
import { validateRelease } from "./validate.js";
import { writeRelease } from "./release.js";
import { SOURCE_LICENSES, type AliasEnrichmentStats, type OfficialRecord, type SourceStats } from "./types.js";

function parseArgs(argv: string[]) {
  const args: { city?: string; overture?: string; stamp?: string; out: string; printBbox: boolean; skipOfficial: boolean; officialFiles: Map<string, string> } = {
    out: "data/releases",
    printBbox: false,
    skipOfficial: false,
    officialFiles: new Map(),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--city") args.city = argv[++i];
    else if (a === "--overture") args.overture = argv[++i];
    else if (a === "--stamp") args.stamp = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--print-bbox") args.printBbox = true;
    else if (a === "--skip-official") args.skipOfficial = true;
    else if (a === "--official-file") {
      const [key, path] = (argv[++i] ?? "").split("=");
      if (!key || !path) throw new Error("--official-file expects <source>=<path>");
      args.officialFiles.set(key, path);
    } else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

async function loadOfficial(
  source: string,
  retrievedAt: string,
  officialFiles: Map<string, string>,
): Promise<OfficialRecord[]> {
  const file = officialFiles.get(source);
  if (source === "fehd_hk") {
    if (file) return parseFehdXml(await readFile(file, "utf8"), null, retrievedAt);
    return fetchFehd(retrievedAt);
  }
  if (source === "la_open_data") {
    if (file) return parseSocrataRows(JSON.parse(await readFile(file, "utf8")), retrievedAt);
    return fetchLaOpenData(retrievedAt);
  }
  if (source === "tokyo_opendata") {
    if (file) {
      const parsed = parseTokyoLicenceCsv(await readFile(file, "utf8"), file, retrievedAt);
      if (parsed.skippedReason) throw new Error(`tokyo_opendata fixture unusable: ${parsed.skippedReason}`);
      return parsed.records;
    }
    return fetchTokyoRegister(retrievedAt);
  }
  throw new Error(`no connector for official source "${source}"`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.city) throw new Error("--city is required (la | tokyo | hk)");
  const city = getCity(args.city);

  if (args.printBbox) {
    const { west, south, east, north } = city.bbox;
    process.stdout.write(`${west},${south},${east},${north}\n`);
    return;
  }
  if (!args.overture) throw new Error("--overture <geojsonseq path> is required");
  if (!args.stamp || !/^\d{4}-\d{2}-\d{2}$/.test(args.stamp)) {
    throw new Error("--stamp YYYY-MM-DD is required (passed by CI so releases are reproducible)");
  }
  const retrievedAt = `${args.stamp}T00:00:00Z`;

  console.log(`[${city.key}] loading Overture extract: ${args.overture}`);
  const { places: staged, drops } = await loadOverture(args.overture, city, retrievedAt);
  console.log(`[${city.key}] ${staged.length} restaurant records (dropped: ${JSON.stringify(drops)})`);

  const conflated = dedupeStaged(staged);
  console.log(`[${city.key}] ${conflated.length} after dedupe (${staged.length - conflated.length} merged)`);

  const sources: SourceStats[] = [
    { source: "overture", ...SOURCE_LICENSES.overture, records: staged.length, retrieved_at: retrievedAt },
  ];
  let crosscheck: CrosscheckStats | null = null;
  if (!args.skipOfficial) {
    for (const source of city.officialSources) {
      console.log(`[${city.key}] loading official register: ${source}`);
      const official = await loadOfficial(source, retrievedAt, args.officialFiles);
      const stats = enrichWithOfficial(conflated, official);
      crosscheck = crosscheck
        ? { matched: crosscheck.matched + stats.matched, ambiguous: crosscheck.ambiguous + stats.ambiguous, unmatched: crosscheck.unmatched + stats.unmatched }
        : stats;
      sources.push({ source, ...SOURCE_LICENSES[source], records: official.length, retrieved_at: retrievedAt });
      console.log(`[${city.key}] ${source}: ${JSON.stringify(stats)}`);
    }
  }

  // Wikidata local-name enrichment AFTER the register pass — register aliases
  // become match keys. Fail-open (ABR lesson): a WDQS outage degrades to
  // today's release, loudly, never blocks it.
  let aliasEnrichment: AliasEnrichmentStats | null = null;
  if (!args.skipOfficial && city.wikidataLanguages.length > 0) {
    console.log(`[${city.key}] wikidata local-name enrichment (${city.wikidataLanguages.join(", ")})`);
    try {
      const file = args.officialFiles.get("wikidata");
      const items = file
        ? parseWikidataResults(JSON.parse(await readFile(file, "utf8")), retrievedAt)
        : await fetchWikidataPlaces(city, retrievedAt);
      aliasEnrichment = enrichWithWikidata(conflated, items);
      sources.push({ source: "wikidata", ...SOURCE_LICENSES.wikidata, records: items.length, retrieved_at: retrievedAt });
      console.log(`[${city.key}] wikidata: ${JSON.stringify(aliasEnrichment)}`);
    } catch (err) {
      console.warn(`[${city.key}] wikidata enrichment unavailable — release proceeds without it. ${String(err)}`);
    }
  }

  const merchants = toReleaseMerchants(city, conflated);
  const report = validateRelease(city, merchants);
  if (report.errors.length > 0) {
    console.error(`[${city.key}] VALIDATION FAILED — release not written:`);
    for (const err of report.errors.slice(0, 50)) console.error(`  - ${err}`);
    if (report.errors.length > 50) console.error(`  … and ${report.errors.length - 50} more`);
    process.exit(1);
  }

  const { dir, manifest } = await writeRelease({
    outDir: args.out,
    stamp: args.stamp,
    city,
    merchants,
    sources,
    crosscheck,
    aliasEnrichment,
    dropped: drops,
    report,
  });
  console.log(`[${city.key}] release written: ${dir} (${report.warnings.length} warnings)`);
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
