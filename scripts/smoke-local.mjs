#!/usr/bin/env node
/**
 * `npm run smoke:local`: the post-deploy smoke (`npm run smoke -- --url …`, scripts/host-smoke.mjs) against
 * this checkout's production build, so CI proves the smoke passes on what would be deployed.
 *
 *   VITE_AUTH_ENABLED=false npm run build:node && npm run smoke:local
 *
 * Starts .output/server on a free port with throwaway keys and PGlite, then runs every check. HSTS is
 * only a warning here (plain http to 127.0.0.1); on a real https host it is required.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHostSmoke } from "./host-smoke.mjs";
import { projectRoot } from "./nitro-preset.mjs";

const freePort = () =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const server = join(projectRoot(), ".output/server/index.mjs");
if (!existsSync(server)) {
  console.error("[smoke:local] no production build: run `VITE_AUTH_ENABLED=false npm run build:node` first");
  process.exit(1);
}
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [server], {
  env: {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    BETTER_AUTH_URL: base,
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    MAIL_CSP: "enforce",
    MAIL_BLOB_KEY: randomBytes(32).toString("hex"),
    MAIL_BLOB_DIR: mkdtempSync(join(tmpdir(), "smoke-blobs-")),
    DATABASE_URL: "",
  },
  stdio: "ignore",
});
let ok = false;
try {
  const until = Date.now() + 60_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > until) throw new Error("the server did not start");
    await new Promise((r) => setTimeout(r, 300));
  }
  ({ ok } = await runHostSmoke(base, { region: "us" }));
} finally {
  child.kill();
}
process.exit(ok ? 0 : 1);
