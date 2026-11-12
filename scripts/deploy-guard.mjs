#!/usr/bin/env node
/**
 * Guardrails for deploying the US workers (docs/deploy/cloudflare-handoff.md), enforced in code so a
 * deploy workflow cannot break them:
 *
 *   - only `cumulus-mail-inbound` and `cumulus-mail-api`; NEVER the existing page worker `cumulus-mail`
 *   - no routes, no custom domains (nothing is bound to mail.cumuluscloud.app)
 *   - no Email Routing changes (no `addresses`), no `send_email`, no R2
 *   - the inbound worker is not on workers.dev; the API worker is only on workers.dev
 *   - the Hyperdrive id placeholder is replaced, and the result is a real id
 *
 * Writes a checked copy of the config for `wrangler deploy --config <copy>` next to the original (so
 * `main` and assets still resolve). Never edits the committed config.
 *
 *   node scripts/deploy-guard.mjs inbound --hyperdrive-id <id>
 *   node scripts/deploy-guard.mjs api --config .output/server/wrangler.json --hyperdrive-id <id>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isMainModule } from "./with-app-env.mjs";
import { parseJsonc, projectRoot } from "./nitro-preset.mjs";

export const TARGETS = {
  inbound: { name: "cumulus-mail-inbound", config: "workers/email/wrangler.jsonc", workersDev: false },
  api: { name: "cumulus-mail-api", config: ".output/server/wrangler.json", workersDev: true },
};

/** The existing page worker serving mail.cumuluscloud.app today. Never a deploy target. */
export const PROTECTED_WORKER = "cumulus-mail";

const FORBIDDEN_KEYS = ["routes", "route", "custom_domains", "addresses", "send_email", "r2_buckets"];
const HYPERDRIVE_ID = /^[0-9a-f]{32}$/;

export class DeployGuardError extends Error {}

/** Check a parsed wrangler config for a target and return the copy to deploy. Throws on any breach. */
export function guardConfig(target, config, { hyperdriveId } = {}) {
  const spec = TARGETS[target];
  if (!spec) throw new DeployGuardError(`Unknown target "${target}". Use inbound or api.`);
  const out = structuredClone(config);
  const fail = (message) => {
    throw new DeployGuardError(`${spec.name}: ${message}`);
  };
  if (out.name === PROTECTED_WORKER) fail(`refusing to deploy over the page worker "${PROTECTED_WORKER}"`);
  if (out.name !== spec.name) fail(`config name is "${out.name}", expected "${spec.name}"`);
  for (const key of FORBIDDEN_KEYS) {
    if (out[key] !== undefined) fail(`"${key}" is not allowed (handoff guardrail)`);
    for (const env of Object.values(out.env ?? {})) {
      if (env && env[key] !== undefined) fail(`"${key}" is not allowed in env overrides`);
    }
  }
  if (Boolean(out.workers_dev) !== spec.workersDev) {
    fail(`workers_dev must be ${spec.workersDev}`);
  }
  const hyperdrive = out.hyperdrive?.[0];
  if (!hyperdrive || hyperdrive.binding !== "HYPERDRIVE") fail("needs the HYPERDRIVE binding");
  if (hyperdrive.id === "REPLACE_WITH_HYPERDRIVE_ID") {
    if (!hyperdriveId) fail("Hyperdrive id is still the placeholder; pass --hyperdrive-id");
    hyperdrive.id = hyperdriveId;
  }
  if (!HYPERDRIVE_ID.test(String(hyperdrive.id))) fail("Hyperdrive id is not a 32-character hex id");
  return out;
}

function arg(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function main(argv = process.argv.slice(2)) {
  const target = argv[0];
  const spec = TARGETS[target];
  if (!spec) throw new DeployGuardError("Usage: deploy-guard.mjs <inbound|api> [--config path] [--hyperdrive-id id]");
  const configPath = join(projectRoot(), arg(argv, "--config") ?? spec.config);
  const config = parseJsonc(readFileSync(configPath, "utf8"));
  const checked = guardConfig(target, config, { hyperdriveId: arg(argv, "--hyperdrive-id")?.trim() });
  const outPath = join(dirname(configPath), "wrangler.deploy.json");
  writeFileSync(outPath, `${JSON.stringify(checked, null, 2)}\n`);
  console.log(`[deploy-guard] ${spec.name}: ok -> ${outPath}`);
  return outPath;
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[deploy-guard] ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
