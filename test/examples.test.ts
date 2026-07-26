/**
 * The examples/ cookbook is corpus-seeding material (AGENT-UX §1): models
 * generate integrations from remembered code, so a snippet that rots into a
 * broken one is worse than no snippet at all. This suite makes rot a build
 * failure instead of a discovery.
 *
 * Everything below is checked against the LIVE contract of a real server boot,
 * not against a copy of it: the OpenAPI document and the MCP tool schemas are
 * fetched from the running process, and the three shell examples are executed
 * end-to-end against it.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXAMPLES_DIR = join(REPO_ROOT, "examples");

/** The one host every example must point at (overridable at runtime, never per-file). */
const CANONICAL_HOST = "agentic-commerce-registry.fly.dev";
/**
 * Hosts an example may legitimately name besides the canonical one: local
 * instances and the deliberately-fake placeholder for the reader's own agent.
 */
const ALLOWED_OTHER_HOSTS = new Set(["localhost:4100", "localhost:8787", "your-agent.example"]);
/** Self-description routes that exist but do not describe themselves in OpenAPI. */
const SELF_DESCRIPTION_PATHS = new Set(["/v1", "/v1/openapi.json"]);

let files: Record<string, string> = {};
let server: ChildProcess | undefined;
let dbDir = "";
let base = "";
let openapi: any;
let mcpTools: { name: string; inputSchema: any }[] = [];

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mcpCall(body: unknown): Promise<any> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
  return res.json();
}

before(async () => {
  for (const name of await readdir(EXAMPLES_DIR)) {
    files[name] = await readFile(join(EXAMPLES_DIR, name), "utf8");
  }

  // The shell examples advertise bash + curl + jq as their only prerequisites;
  // fail with that sentence rather than an opaque spawn error if one is absent.
  for (const tool of ["bash", "curl", "jq"]) {
    await execFileAsync("sh", ["-c", `command -v ${tool}`]).catch(() => {
      throw new Error(`${tool} is required to run the shell examples (bash + curl + jq)`);
    });
  }

  // A real boot on a throwaway DB: the examples are only "runnable" if they
  // run against the actual server, seeded corpus, worker and all.
  dbDir = await mkdtemp(join(tmpdir(), "registry-examples-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["--import", "tsx", "src/api/server.ts"], {
    cwd: REPO_ROOT,
    env: { ...process.env, REGISTRY_DB: join(dbDir, "examples.db"), PORT: String(port) },
    stdio: "ignore",
  });

  const deadline = Date.now() + 90_000;
  for (;;) {
    if (server.exitCode !== null) throw new Error(`server exited early (code ${server.exitCode})`);
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("server did not become healthy within 90s");
    await sleep(500);
  }

  openapi = await (await fetch(`${base}/v1/openapi.json`)).json();
  mcpTools = (await mcpCall({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools;
});

after(async () => {
  server?.kill("SIGKILL");
  if (dbDir) await rm(dbDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* The index is the entry point — it may never fall behind the files.  */
/* ------------------------------------------------------------------ */

test("every example is linked from the cookbook index", () => {
  const readme = files["README.md"];
  assert.ok(readme, "examples/README.md must exist");
  for (const name of Object.keys(files)) {
    if (name === "README.md") continue;
    assert.ok(readme.includes(`(${name})`), `examples/README.md does not link ${name}`);
  }
});

test("every example points at the same base URL", () => {
  for (const [name, body] of Object.entries(files)) {
    for (const [, host] of body.matchAll(/https?:\/\/([A-Za-z0-9.:-]+)/g)) {
      if (host === CANONICAL_HOST || ALLOWED_OTHER_HOSTS.has(host)) continue;
      // Docs/spec links are fine; a second registry host is not.
      assert.ok(
        !/registry|mercantry|fly\.dev/i.test(host),
        `${name} names a different registry host (${host}) — examples must agree on one`,
      );
    }
  }
});

/* ------------------------------------------------------------------ */
/* Contract: paths, tools and fields must exist on the live surface.   */
/* ------------------------------------------------------------------ */

/** `/v1/bookings/$ID/cancel` and `/v1/bookings/{booking_id}/cancel` compare equal. */
const normalizePath = (p: string) =>
  p
    .split("/")
    .map((seg) => (/[${]/.test(seg) ? "{param}" : seg))
    .join("/");

test("every /v1 path used by an example exists in the OpenAPI document", () => {
  const documented = new Set([
    ...Object.keys(openapi.paths).map(normalizePath),
    ...SELF_DESCRIPTION_PATHS,
  ]);
  for (const [name, body] of Object.entries(files)) {
    for (const [, raw] of body.matchAll(/(\/v1(?:\/[A-Za-z0-9_.${}-]+)*)/g)) {
      const path = normalizePath(raw.replace(/[.,)]+$/, ""));
      assert.ok(documented.has(path), `${name} calls ${raw} — not in the served OpenAPI paths`);
    }
  }
});

test("every MCP tool an example names is a tool the server registers", () => {
  const registered = new Set(mcpTools.map((t) => t.name));
  for (const [name, body] of Object.entries(files)) {
    // Standalone identifiers only — `client.get_tools()` is the SDK's method,
    // not a claim about the registry's tool surface.
    for (const [token] of body.matchAll(/(?<![.\w])(?:get|place|search|modify|cancel|submit)_[a-z_]+\b/g)) {
      assert.ok(registered.has(token), `${name} names ${token}, which is not a registered MCP tool`);
    }
  }
});

test("search filters used in the curl examples are real query parameters", () => {
  const documented = new Set(
    (openapi.paths["/v1/merchants"].get.parameters as { name: string }[]).map((p) => p.name),
  );
  for (const [name, body] of Object.entries(files)) {
    for (const [, param] of body.matchAll(/--data-urlencode "([a-z_]+)=/g)) {
      assert.ok(documented.has(param), `${name} sends ?${param} to /v1/merchants — undocumented`);
    }
  }
});

test("place_booking fields used by the walkthrough exist in both contracts", () => {
  const rest = new Set(
    Object.keys(
      openapi.paths["/v1/bookings"].post.requestBody.content["application/json"].schema.properties,
    ),
  );
  const mcp = new Set(Object.keys(mcpTools.find((t) => t.name === "place_booking")!.inputSchema.properties));

  const walkthrough = files["booking-walkthrough.sh"];
  const blocks = [...walkthrough.matchAll(/jq -n[^']*'\{([\s\S]*?)\}'/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 2, "expected the place + replay payload blocks");

  const seen = new Set<string>();
  for (const block of blocks) {
    for (const [, field] of block.matchAll(/([a-z_]+)\s*:/g)) {
      seen.add(field);
      assert.ok(rest.has(field), `booking-walkthrough.sh sends ${field} — not in the REST schema`);
      assert.ok(mcp.has(field), `booking-walkthrough.sh sends ${field} — not in the MCP schema`);
    }
  }
  // The one field whose absence is a correctness bug, not a doc gap.
  assert.ok(seen.has("client_reference_id"), "the walkthrough must demonstrate retry safety");
});

test("the sandbox filter the examples rely on is offered on both surfaces", () => {
  const rest = (openapi.paths["/v1/merchants"].get.parameters as { name: string }[]).map((p) => p.name);
  assert.ok(rest.includes("sandbox"), "REST search must expose the sandbox filter");
  const search = mcpTools.find((t) => t.name === "search_merchants")!;
  assert.ok(search.inputSchema.properties.sandbox, "MCP search_merchants must expose the sandbox filter");
  assert.ok(
    openapi.components.schemas.MerchantSummary.properties.sandbox,
    "compact search records must carry sandbox — it is how an agent tells a test venue from a real one",
  );
});

/* ------------------------------------------------------------------ */
/* Runnable means runnable: execute them against the booted server.    */
/* ------------------------------------------------------------------ */

const runExample = (file: string, extraEnv: Record<string, string> = {}) =>
  execFileAsync("bash", [join(EXAMPLES_DIR, file), base], {
    env: { ...process.env, ...extraEnv },
    maxBuffer: 4 * 1024 * 1024,
  });

test("first-query.sh runs clean against a live server", async () => {
  const { stdout } = await runExample("first-query.sh");
  assert.match(stdout, /registry meta/);
  assert.match(stdout, /"schema_version"/);
});

test("mcp-json-rpc.sh runs clean and exercises the error contract", async () => {
  const { stdout } = await runExample("mcp-json-rpc.sh");
  assert.match(stdout, /search_merchants/);
  assert.match(stdout, /"isError": true/);
  assert.match(stdout, /unknown_merchant/);
});

test("booking-walkthrough.sh books a sandbox merchant end to end", async () => {
  const { stdout } = await runExample("booking-walkthrough.sh", { POLL_SECONDS: "60" });
  // Retry safety is the claim the walkthrough exists to prove.
  assert.match(stdout, /"idempotent_replay": true/);
  const state = stdout.match(/state: (\w+)/g)?.pop();
  assert.ok(state, "the walkthrough must report booking states");
  // Outcomes are drawn per booking, so pin the state machine, not one outcome.
  assert.match(
    stdout,
    /state: (queued|in_progress|confirmed|failed|needs_input|cancelled)/,
    "reported state must be a documented booking state",
  );
});
