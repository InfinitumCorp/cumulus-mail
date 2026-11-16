#!/usr/bin/env node
/**
 * Performance budget for the production build (`npm run build:node`, then `npm run perf`).
 *
 * Starts the built server, loads each route in Chromium and records:
 *   - the JavaScript that route makes the browser download, as gzip bytes of the files on disk (stable
 *     run to run, unlike transfer timings);
 *   - Lighthouse-style timings from the Performance API: time to first byte, first contentful paint,
 *     DOMContentLoaded and load.
 * Then checks them, and the whole client bundle, against `perf-budget.json` and exits 1 when anything
 * is over. Timings are reported, and only fail far past their budget, because CI machines vary; the byte
 * budgets are exact.
 *
 * Measured against the production build on purpose: the dev server serves unbundled modules, so its
 * sizes and timings say nothing about what people get.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { isMainModule } from "./with-app-env.mjs";
import { projectRoot } from "./nitro-preset.mjs";

const gz = (path) => gzipSync(readFileSync(path), { level: 9 }).length;

/** Gzip size of every JS file in the client bundle, largest first. */
export function bundleSizes(assetsDir) {
  return readdirSync(assetsDir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => ({ name, gzip: gz(join(assetsDir, name)) }))
    .sort((a, b) => b.gzip - a.gzip);
}

/** Over-budget lines for a measurement, or an empty list. Timings fail only past `timingSlack` x budget. */
export function overBudget(measured, budget, timingSlack = 2) {
  const problems = [];
  if (measured.totalJsGzip > budget.totalJsGzip) problems.push(`total JS ${kb(measured.totalJsGzip)} > ${kb(budget.totalJsGzip)}`);
  if (measured.largestChunkGzip > budget.largestChunkGzip) problems.push(`largest chunk ${kb(measured.largestChunkGzip)} > ${kb(budget.largestChunkGzip)}`);
  for (const route of measured.routes) {
    const b = budget.routes[route.path];
    if (!b) continue;
    if (route.jsGzip > b.jsGzip) problems.push(`${route.path}: JS ${kb(route.jsGzip)} > ${kb(b.jsGzip)}`);
    // Chunks that must stay lazy on this route (openpgp is 120 kB and only needed to read sealed mail).
    for (const name of b.forbid ?? []) {
      const loaded = route.js.filter((file) => file.startsWith(name));
      if (loaded.length) problems.push(`${route.path}: loads ${loaded.join(", ")} up front; it should stay lazy`);
    }
    for (const key of ["fcp", "load"]) {
      if (b[key] && route[key] > b[key] * timingSlack) problems.push(`${route.path}: ${key} ${route[key]} ms > ${b[key]} ms x${timingSlack}`);
    }
  }
  return problems;
}

export const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(url, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`server did not answer at ${url}`);
}

async function launch() {
  const { chromium } = await import("playwright");
  try {
    return await chromium.launch(process.env.E2E_CHROMIUM_PATH ? { executablePath: process.env.E2E_CHROMIUM_PATH } : {});
  } catch (error) {
    if (!existsSync("/opt/pw-browsers/chromium")) throw error;
    return chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  }
}

async function measureRoute(browser, base, assetsDir, path, ready) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const scripts = new Set();
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/assets/") && url.pathname.endsWith(".js")) scripts.add(url.pathname.slice("/assets/".length));
  });
  await page.goto(`${base}${path}`, { waitUntil: "load" });
  if (ready) await page.locator(ready).first().waitFor({ timeout: 30_000 });
  await page.waitForLoadState("networkidle");
  const timing = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const fcp = performance.getEntriesByName("first-contentful-paint")[0];
    return {
      ttfb: Math.round(nav.responseStart),
      fcp: Math.round(fcp?.startTime ?? 0),
      dcl: Math.round(nav.domContentLoadedEventEnd),
      load: Math.round(nav.loadEventEnd),
    };
  });
  await context.close();
  const files = [...scripts].filter((name) => existsSync(join(assetsDir, name)));
  return { path, js: files.sort(), jsGzip: files.reduce((sum, name) => sum + gz(join(assetsDir, name)), 0), ...timing };
}

export const ROUTES = [
  { path: "/", ready: "[data-row-id]" },
  { path: "/p/00000000000000000000000000000000", ready: "body" },
];

async function main() {
  const root = projectRoot();
  const server = join(root, ".output/server/index.mjs");
  const assetsDir = join(root, ".output/public/assets");
  if (!existsSync(server)) {
    console.error("[perf] no production build: run `npm run build:node` first");
    process.exit(1);
  }
  const budget = JSON.parse(readFileSync(join(root, "perf-budget.json"), "utf8"));
  const port = await freePort();
  const child = spawn(process.execPath, [server], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", MAIL_BLOB_KEY: randomBytes(32).toString("hex"), DATABASE_URL: "" },
    stdio: "ignore",
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    await waitFor(`${base}/api/health`, 60_000);
    const browser = await launch();
    const routes = [];
    try {
      for (const route of ROUTES) routes.push(await measureRoute(browser, base, assetsDir, route.path, route.ready));
    } finally {
      await browser.close();
    }
    const sizes = bundleSizes(assetsDir);
    const measured = {
      totalJsGzip: sizes.reduce((sum, s) => sum + s.gzip, 0),
      largestChunkGzip: sizes[0]?.gzip ?? 0,
      largestChunk: sizes[0]?.name ?? "",
      routes,
    };
    console.log(`[perf] client JS: ${kb(measured.totalJsGzip)} gzip in ${sizes.length} files; largest ${measured.largestChunk} ${kb(measured.largestChunkGzip)}`);
    console.log("[perf] route                              JS gzip    TTFB   FCP    DCL    load  (ms)");
    for (const r of routes) {
      console.log(`[perf] ${r.path.padEnd(34)} ${kb(r.jsGzip).padStart(9)} ${String(r.ttfb).padStart(6)} ${String(r.fcp).padStart(6)} ${String(r.dcl).padStart(6)} ${String(r.load).padStart(6)}`);
      console.log(`[perf]   ${r.js.join(", ")}`);
    }
    const problems = overBudget(measured, budget);
    if (problems.length) {
      for (const p of problems) console.error(`[perf] OVER BUDGET: ${p}`);
      console.error("[perf] if the growth is intended, raise perf-budget.json in the same change and say why");
      process.exitCode = 1;
    } else {
      console.log("[perf] within budget");
    }
  } finally {
    child.kill();
  }
}

if (isMainModule(import.meta.url)) await main();
