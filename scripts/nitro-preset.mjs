/**
 * Nitro preset selection. The default build stays `vercel`.
 * `NITRO_PRESET=cloudflare-module` builds the API worker and nothing else.
 * That preset must not be pointed at mail.cumuluscloud.app.
 * `NITRO_PRESET=node-server` builds a plain Node server for the Russia copy
 * (ru.mail.cumuluscloud.app on Yandex Cloud; see docs/deploy/yandex-ru.md).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const VERCEL_PRESET = "vercel";
export const WORKERS_PRESET = "cloudflare-module";
/** Plain Node server (`node .output/server/index.mjs`), for the Russia copy on Yandex Cloud. */
export const NODE_PRESET = "node-server";

const ALLOWED = new Set([VERCEL_PRESET, WORKERS_PRESET, NODE_PRESET]);

export function nitroPreset(env = process.env) {
  const requested = (env.NITRO_PRESET ?? "").trim();
  if (!requested) return VERCEL_PRESET;
  if (!ALLOWED.has(requested)) {
    throw new Error(`NITRO_PRESET must be ${VERCEL_PRESET}, ${WORKERS_PRESET} or ${NODE_PRESET}`);
  }
  return requested;
}

/**
 * JSON.parse a wrangler jsonc file: drops // and block comments, but never inside a string. (A regex stripper once turned Nitro's `"**\/*.mjs", "**\/*.js"` module globs into `"***.js"`,
 * so the guarded deploy config uploaded only the entry file and the API worker could not start.)
 */
export function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else {
      out += c;
    }
  }
  return JSON.parse(out);
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
