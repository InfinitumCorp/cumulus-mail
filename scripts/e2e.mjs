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
import { readdirSync } from "node:fs";
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
  // Warm the page once so the first test does not pay for Vite's dependency optimisation.
  await fetch(url).catch(() => undefined);
  const files = readdirSync(join(root, "e2e"))
    .filter((name) => name.endsWith(".e2e.mjs"))
    // E2E_ONLY=billing,a11y runs just the files whose names contain one of those words.
    .filter((name) => !process.env.E2E_ONLY || process.env.E2E_ONLY.split(",").some((part) => part && name.includes(part.trim())))
    .map((name) => join("e2e", name));
  const run = spawn(process.execPath, ["--test", "--test-concurrency=1", ...files], {
    cwd: root,
    env: { ...process.env, E2E_URL: url },
    stdio: "inherit",
  });
  code = await new Promise((resolve) => run.on("exit", (exit) => resolve(exit ?? 1)));
} catch (error) {
  console.error(`[e2e] ${error instanceof Error ? error.message : error}`);
  console.error(log.slice(-4000));
} finally {
  server.kill("SIGTERM");
}
process.exit(code);
