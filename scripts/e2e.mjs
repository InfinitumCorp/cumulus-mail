#!/usr/bin/env node
/**
 * Browser smoke tests for the mail app (`npm run test:e2e`).
 *
 * Starts the dev server in the local mode the README describes (sign-in off, no DATABASE_URL, so an
 * in-memory PGLite mailbox with sample mail, and a throwaway MAIL_BLOB_KEY), runs e2e/*.e2e.mjs
 * against it with Playwright's Chromium, then stops the server. Nothing here talks to Cumulus ID or a
 * real database. Refuses to run when DATABASE_URL is set.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

if (process.env.DATABASE_URL) {
  console.error("[e2e] DATABASE_URL is set. These tests use the in-memory dev mailbox only; unset it.");
  process.exit(1);
}

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

async function waitFor(url, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`dev server did not answer at ${url} within ${timeoutMs / 1000}s`);
}

/**
 * Vite finds most of the client's dependencies only when a browser first loads the app, bundles them,
 * and then (on a later load, when it finds the lazily imported ones) logs "optimized dependencies
 * changed. reloading" and reloads every open page. A test that is running at that moment loses its
 * page mid-step (seen as `waiting for navigation to finish` timeouts, mostly in the first test file and
 * under load). So before any test runs, load the app in a real browser until a load passes with no new
 * optimisation, then the dev server is stable for the rest of the run.
 */
async function warmUp(url) {
  const { chromium } = await import("playwright");
  const path = process.env.E2E_CHROMIUM_PATH;
  let browser;
  try {
    browser = await chromium.launch(path ? { executablePath: path } : {});
  } catch (error) {
    if (path || !existsSync("/opt/pw-browsers/chromium")) throw error;
    browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  }
  const optimisations = () => (log.match(/dependencies optimized|optimized dependencies changed/g) ?? []).length;
  try {
    for (let round = 1; round <= 5; round += 1) {
      const before = optimisations();
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: "networkidle", timeout: 90_000 }).catch(() => undefined);
      await page.locator("[data-row-id]").first().waitFor({ timeout: 60_000 }).catch(() => undefined);
      // Give the optimiser time to notice anything this load imported lazily.
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      await page.close();
      if (optimisations() === before) {
        console.log(`[e2e] dev server warm after ${round} browser load(s)`);
        return;
      }
    }
    console.log("[e2e] dev server still optimising after 5 loads; running the tests anyway");
  } finally {
    await browser.close();
  }
}

const port = Number(process.env.E2E_PORT) || (await freePort());
const url = `http://127.0.0.1:${port}/`;
const env = {
  ...process.env,
  VITE_AUTH_ENABLED: "false",
  MAIL_BLOB_KEY: randomBytes(32).toString("hex"),
  MAIL_BLOB_DIR: join(root, ".data", `e2e-blobs-${process.pid}`),
};
const server = spawn(
  process.execPath,
  [join(root, "scripts/with-app-env.mjs"), "vite", "dev", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
);
let log = "";
server.stdout.on("data", (chunk) => (log += chunk));
server.stderr.on("data", (chunk) => (log += chunk));

let code = 1;
try {
  await waitFor(url, 90_000);
  await warmUp(url);
  const warmLogLength = log.length;
  const files = readdirSync(join(root, "e2e"))
    .filter((name) => name.endsWith(".e2e.mjs"))
    .map((name) => join("e2e", name));
  const run = spawn(process.execPath, ["--test", "--test-concurrency=1", ...files], {
    cwd: root,
    env: { ...process.env, E2E_URL: url },
    stdio: "inherit",
  });
  code = await new Promise((resolve) => run.on("exit", (exit) => resolve(exit ?? 1)));
  if (/optimized dependencies changed/.test(log.slice(warmLogLength))) {
    console.warn("[e2e] warning: the dev server re-optimised dependencies and reloaded pages during the run; a failure above may be that, not the test");
  }
} catch (error) {
  console.error(`[e2e] ${error instanceof Error ? error.message : error}`);
  console.error(log.slice(-4000));
} finally {
  server.kill("SIGTERM");
}
process.exit(code);
