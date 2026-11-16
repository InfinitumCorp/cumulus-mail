#!/usr/bin/env node
/**
 * `npm run e2e:prod`: the end-to-end tests that must hold on the PRODUCTION build (CSP enforced, minified
 * bundles, the Node server), not just the dev server: a first user's whole session (e2e/first-user.e2e.mjs).
 *
 *   VITE_AUTH_ENABLED=false npm run build:node && npm run e2e:prod
 *
 * Local mode (VITE_AUTH_ENABLED=false at build AND run time) signs in as the development mailbox, with
 * PGlite and throwaway keys. Sign-up itself happens at Cumulus ID and is not part of this app.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectRoot } from "./nitro-preset.mjs";

const SPECS = ["e2e/first-user.e2e.mjs"];

const freePort = () =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const root = projectRoot();
const server = join(root, ".output/server/index.mjs");
if (!existsSync(server)) {
  console.error("[e2e:prod] no production build: run `VITE_AUTH_ENABLED=false npm run build:node` first");
  process.exit(1);
}
const port = await freePort();
const base = `http://127.0.0.1:${port}/`;
const app = spawn(process.execPath, [server], {
  env: {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    VITE_AUTH_ENABLED: "false",
    MAIL_CSP: "enforce",
    MAIL_BLOB_KEY: randomBytes(32).toString("hex"),
    MAIL_BLOB_DIR: mkdtempSync(join(tmpdir(), "e2e-prod-blobs-")),
    DATABASE_URL: "",
  },
  stdio: "ignore",
});
let code = 1;
try {
  const until = Date.now() + 60_000;
  for (;;) {
    try {
      if ((await fetch(`${base}api/health`)).ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > until) throw new Error("the production server did not start");
    await new Promise((r) => setTimeout(r, 300));
  }
  code = await new Promise((resolve) => {
    const run = spawn(process.execPath, ["--test", "--test-concurrency=1", ...SPECS], {
      cwd: root,
      env: { ...process.env, E2E_URL: base },
      stdio: "inherit",
    });
    run.on("exit", (exit) => resolve(exit ?? 1));
  });
} finally {
  app.kill();
}
process.exit(code);
