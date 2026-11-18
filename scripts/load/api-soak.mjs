#!/usr/bin/env node
/**
 * `npm run soak:api -- --minutes 30 --concurrency 8`: a soak of the PRODUCTION server (.output/server),
 * looking for drift over time — memory that keeps growing, or latency that keeps rising — rather than peak
 * throughput (docs/ops/load-test.md has the inbound load test for that).
 *
 * It starts the server itself (so it can read the process's RSS), in local mode with the CSP enforced, and
 * keeps `--concurrency` requests in flight, cycling through what an anonymous visitor and the monitors hit:
 *   GET /                         the server-rendered app (the heaviest page)
 *   GET /api/health?deep=1        database + storage + schema checks
 *   GET /no/such/page             the 404 page
 *   GET /api/account/export/x     a refused export link (signature check)
 *   POST /api/csp-report          a violation report
 * With DATABASE_URL set it uses that Postgres; otherwise PGlite.
 *
 * `--url https://staging.example` soaks a deployed copy instead (docs/ops/staging-load.md): no server is
 * started, RSS is not measured, and production hosts are refused.
 *
 * Every minute it prints requests, errors, p50/p95/p99 and RSS. At the end it compares the last third of
 * the run with the first third (after a warm-up minute) and fails if RSS grew more than 25% or p95 more
 * than 50%: that is what a leak or an accumulating cache looks like.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..", "..");
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? Number(args[at + 1]) : fallback;
};
const minutes = arg("--minutes", 30);
const concurrency = arg("--concurrency", 8);
const urlAt = args.indexOf("--url");
const targetUrl = urlAt >= 0 ? args[urlAt + 1] ?? "" : "";

/** Hosts the soak must never be pointed at: it is load, and production has real people on it. */
export const PRODUCTION_HOSTS = ["cumuluscloud.app", "mail.cumuluscloud.app", "ru.mail.cumuluscloud.app", "id.cumuluscloud.app", "ru.id.cumuluscloud.app"];

/** The base URL for `--url`, or an error message. Only https, never a production host. */
export function soakTarget(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { error: `--url is not a URL: ${url}` };
  }
  if (parsed.protocol !== "https:") return { error: "--url must be https://" };
  if (PRODUCTION_HOSTS.includes(parsed.hostname.toLowerCase())) return { error: `${parsed.hostname} is production; point the soak at staging` };
  return { base: parsed.origin };
}

/** p-th percentile (0–100) of sorted numbers. */
export function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** Drift between the first and last thirds of the per-minute rows (after the warm-up row). */
export function drift(rows) {
  // Skip the warm-up minute, and a partial last minute (a handful of requests) that would skew the averages.
  const counts = rows.map((r) => r.requests ?? 1).sort((a, b) => a - b);
  const median = counts[Math.floor(counts.length / 2)] ?? 0;
  const steady = rows.slice(1).filter((r) => (r.requests ?? median) >= median / 2);
  if (steady.length < 3) return { rssGrowth: 0, p95Growth: 0, ok: true };
  const third = Math.max(1, Math.floor(steady.length / 3));
  const avg = (xs, key) => xs.reduce((sum, r) => sum + r[key], 0) / xs.length;
  const first = steady.slice(0, third);
  const last = steady.slice(-third);
  // A remote target (--url) has no process to measure: judge latency alone.
  const rssGrowth = avg(first, "rssMb") > 0 ? avg(last, "rssMb") / avg(first, "rssMb") - 1 : 0;
  const p95Growth = avg(last, "p95") / Math.max(1, avg(first, "p95")) - 1;
  return { rssGrowth, p95Growth, ok: rssGrowth <= 0.25 && p95Growth <= 0.5 };
}

const rssMb = (pid) => {
  try {
    const line = readFileSync(`/proc/${pid}/status`, "utf8").split("\n").find((l) => l.startsWith("VmRSS:"));
    return line ? Number(line.replace(/\D+/g, "")) / 1024 : 0;
  } catch {
    return 0;
  }
};

/** Start the production build locally and return its base URL and process (or null for --url). */
async function startLocal() {
  const serverPath = join(root, ".output/server/index.mjs");
  if (!existsSync(serverPath)) {
    console.error("[soak] no production build: VITE_AUTH_ENABLED=false npm run build:node");
    process.exit(1);
  }
  const port = await new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port: p } = s.address();
      s.close(() => resolve(p));
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      VITE_AUTH_ENABLED: "false",
      MAIL_CSP: "enforce",
      MAIL_BLOB_KEY: process.env.MAIL_BLOB_KEY ?? randomBytes(32).toString("hex"),
      MAIL_BLOB_DIR: mkdtempSync(join(tmpdir(), "soak-blobs-")),
      DATABASE_URL: process.env.DATABASE_URL ?? "",
    },
    stdio: "ignore",
  });
  const until = Date.now() + 60_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      // starting
    }
    if (Date.now() > until) throw new Error("server did not start");
    await new Promise((r) => setTimeout(r, 300));
  }
  return { base, server };
}

async function main() {
  let base;
  let server = null;
  if (urlAt >= 0) {
    const target = soakTarget(targetUrl);
    if (target.error) {
      console.error(`[soak] ${target.error}`);
      process.exit(2);
    }
    base = target.base;
    console.log(`[soak] remote target ${base}: RSS is not measured, latency drift and errors still fail the run`);
  } else ({ base, server } = await startLocal());

  const report = JSON.stringify({ "csp-report": { "document-uri": `${base}/`, "effective-directive": "img-src", "blocked-uri": "https://example.org/x.png" } });
  const requests = [
    () => fetch(`${base}/`),
    () => fetch(`${base}/api/health?deep=1`),
    () => fetch(`${base}/no/such/page`),
    () => fetch(`${base}/api/account/export/not-a-token`),
    () => fetch(`${base}/api/csp-report`, { method: "POST", headers: { "content-type": "application/csp-report" }, body: report }),
  ];
  const expected = [200, 200, 404, 403, 204];

  let window = { latencies: [], errors: 0 };
  const rows = [];
  const end = Date.now() + minutes * 60_000;
  let n = 0;
  const worker = async () => {
    while (Date.now() < end) {
      const i = n++ % requests.length;
      const t = performance.now();
      try {
        const response = await requests[i]();
        await response.arrayBuffer();
        if (response.status !== expected[i]) window.errors += 1;
      } catch {
        window.errors += 1;
      }
      window.latencies.push(performance.now() - t);
    }
  };
  const flush = () => {
    const sorted = window.latencies.sort((a, b) => a - b);
    const row = {
      minute: rows.length + 1,
      requests: sorted.length,
      errors: window.errors,
      p50: Math.round(percentile(sorted, 50)),
      p95: Math.round(percentile(sorted, 95)),
      p99: Math.round(percentile(sorted, 99)),
      rssMb: server ? Math.round(rssMb(server.pid)) : 0,
    };
    rows.push(row);
    window = { latencies: [], errors: 0 };
    console.log(`[soak] min ${String(row.minute).padStart(2)}  ${String(row.requests).padStart(6)} req  ${row.errors} err  p50 ${row.p50} ms  p95 ${row.p95} ms  p99 ${row.p99} ms  rss ${row.rssMb} MB`);
  };
  const ticker = setInterval(flush, 60_000);
  await Promise.all(Array.from({ length: concurrency }, worker));
  clearInterval(ticker);
  if (window.latencies.length) flush();
  server?.kill();
  const d = drift(rows);
  const errors = rows.reduce((sum, r) => sum + r.errors, 0);
  console.log(
    `[soak] ${minutes} min, ${concurrency} in flight: ${rows.reduce((s, r) => s + r.requests, 0)} requests, ${errors} errors; ` +
      `RSS ${d.rssGrowth >= 0 ? "+" : ""}${(d.rssGrowth * 100).toFixed(1)}%, p95 ${d.p95Growth >= 0 ? "+" : ""}${(d.p95Growth * 100).toFixed(1)}% (last third vs first)`,
  );
  process.exit(d.ok && errors === 0 ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
