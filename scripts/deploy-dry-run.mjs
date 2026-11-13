#!/usr/bin/env node
/**
 * `npm run deploy:dry-run`: build exactly what "Deploy US (Cloudflare)" would ship, run it through the
 * same guard, and ask wrangler for a dry run of each worker. Nothing is uploaded and no Cloudflare login
 * is needed. Then check what a dry run does not: that every module the API worker imports is in the
 * upload. (A comment-stripping bug once dropped them all and the worker could not start.)
 *
 *   npm run deploy:dry-run            both workers
 *   npm run deploy:dry-run -- api     one of them
 *
 * The Russia image and the local smoke runs are in docs/deploy/dry-run.md.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { main as guard } from "./deploy-guard.mjs";
import { projectRoot } from "./nitro-preset.mjs";

/** Workers' compressed script limit on paid plans (free is 3 MiB). */
export const MAX_GZIP_BYTES = 10 * 1024 * 1024;
const WRANGLER = ["--yes", "wrangler@4.157.0"];
const DUMMY_HYPERDRIVE = "0".repeat(32);

export function listFiles(dir, base = dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path, base) : [relative(base, path)];
  });
}

/** Modules in the built server that the dry-run upload left out (README and the configs are not modules). */
export function missingModules(serverFiles, uploadedFiles) {
  const uploaded = new Set(uploadedFiles);
  return serverFiles.filter((file) => /\.(mjs|js)$/.test(file) && !uploaded.has(file));
}

function dryRun(cwd, outdir) {
  execFileSync("npx", [...WRANGLER, "deploy", "--dry-run", "--outdir", outdir, "--config", "wrangler.deploy.json"], {
    cwd,
    stdio: ["ignore", "inherit", "inherit"],
  });
}

const gzipSize = (files, dir) => files.reduce((n, file) => n + gzipSync(readFileSync(join(dir, file))).length, 0);

export function run(targets = ["inbound", "api"]) {
  const root = projectRoot();
  const out = join(root, ".output", "dry-run");
  const report = [];
  if (targets.includes("inbound")) {
    guard(["inbound", "--hyperdrive-id", DUMMY_HYPERDRIVE]);
    const dir = join(out, "inbound");
    dryRun(join(root, "workers/email"), dir);
    const files = listFiles(dir).filter((f) => /\.(mjs|js)$/.test(f));
    report.push({ worker: "inbound", modules: files.length, gzip: gzipSize(files, dir), missing: [] });
  }
  if (targets.includes("api")) {
    execFileSync("npm", ["run", "build:workers"], { cwd: root, stdio: "inherit" });
    guard(["api", "--hyperdrive-id", DUMMY_HYPERDRIVE]);
    const dir = join(out, "api");
    dryRun(join(root, ".output/server"), dir);
    const built = listFiles(join(root, ".output/server"));
    const uploaded = listFiles(dir);
    const files = uploaded.filter((f) => /\.(mjs|js)$/.test(f));
    report.push({ worker: "api", modules: files.length, gzip: gzipSize(files, dir), missing: missingModules(built, uploaded) });
  }
  let ok = true;
  for (const r of report) {
    const size = `${(r.gzip / 1024 / 1024).toFixed(2)} MiB gzip`;
    const problems = [
      ...(r.missing.length ? [`${r.missing.length} module(s) not uploaded: ${r.missing.slice(0, 3).join(", ")}`] : []),
      ...(r.gzip > MAX_GZIP_BYTES ? [`over the ${MAX_GZIP_BYTES / 1024 / 1024} MiB limit`] : []),
    ];
    ok &&= problems.length === 0;
    console.log(`[dry-run] ${r.worker}: ${r.modules} module(s), ${size} ${problems.length ? `FAIL ${problems.join("; ")}` : "ok"}`);
  }
  return ok;
}

if (process.argv[1] && import.meta.url.endsWith("deploy-dry-run.mjs")) {
  const asked = process.argv.slice(2).filter((a) => a === "api" || a === "inbound");
  process.exit(run(asked.length ? asked : undefined) ? 0 : 1);
}
