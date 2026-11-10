/**
 * Nitro preset selection. The default build stays `vercel`.
 * `NITRO_PRESET=cloudflare-module` builds the API worker and nothing else.
 * That preset must not be pointed at mail.cumuluscloud.app.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const VERCEL_PRESET = "vercel";
export const WORKERS_PRESET = "cloudflare-module";

const ALLOWED = new Set([VERCEL_PRESET, WORKERS_PRESET]);

export function nitroPreset(env = process.env) {
  const requested = (env.NITRO_PRESET ?? "").trim();
  if (!requested) return VERCEL_PRESET;
  if (!ALLOWED.has(requested)) {
    throw new Error(`NITRO_PRESET must be ${VERCEL_PRESET} or ${WORKERS_PRESET}`);
  }
  return requested;
}

/** Strip // and block comments enough to JSON.parse a wrangler jsonc file. */
export function parseJsonc(text) {
  const withoutBlock = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const withoutLine = withoutBlock.replace(/^\s*\/\/.*$/gm, "");
  return JSON.parse(withoutLine);
}

export function projectRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

export function readWorkerConfig(relativePath) {
  return parseJsonc(readFileSync(join(projectRoot(), relativePath), "utf8"));
}

/**
 * Wrangler fields Nitro should keep when it writes the module-worker config.
 * `main` is omitted so Nitro can point it at the built server entry.
 */
export function workersApiNitroWrangler() {
  const config = readWorkerConfig("workers/api/wrangler.jsonc");
  delete config.main;
  delete config.$schema;
  return config;
}

export function workersApiCloudflareOptions() {
  return {
    deployConfig: true,
    nodeCompat: true,
    wrangler: workersApiNitroWrangler(),
  };
}
