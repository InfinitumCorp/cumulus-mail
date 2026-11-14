/**
 * Fails if server-only code reaches the browser bundle.
 *
 * The client assets in `.output/public/assets` are public. Server modules (the
 * database adapter, the migrator, storage, mail crypto keys) must never be in
 * them: they would leak internals and bloat every page. Vite's dev optimizer
 * may pre-bundle such modules while discovering deps, so the dev server is not
 * evidence either way; this checks the production build.
 *
 * Usage: node scripts/client-bundle-guard.mjs [assets-dir]   (after a build)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Strings that only server code contains. Each is a module, an API or a server secret's name. */
export const SERVER_MARKERS = [
  // better-auth's server side and its database layer (the browser client is fine).
  "kyselyAdapter",
  "createInternalAdapter",
  "getMigrations",
  "better-auth/adapters",
  "class Kysely",
  // Databases and storage.
  "@electric-sql/pglite",
  "PGlite",
  "pg-protocol",
  "S3Client",
  // Node built-ins.
  "node:fs",
  "node:net",
  "node:tls",
  "node:child_process",
  // Server secrets by name. BETTER_AUTH_SECRET is not listed: better-auth's browser client names it
  // in an env getter that reads nothing in a browser.
  "MAIL_BLOB_KEY",
  "MAIL_BLIND_KEY",
  "CRON_SECRET",
  "DATABASE_URL",
];

/** [{ file, marker }] for every marker found in the given { name: text } map. */
export function findServerCode(files, markers = SERVER_MARKERS) {
  const hits = [];
  for (const [file, text] of Object.entries(files)) {
    for (const marker of markers) if (text.includes(marker)) hits.push({ file, marker });
  }
  return hits;
}

function readAssets(dir) {
  const files = {};
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      for (const [sub, text] of Object.entries(readAssets(path))) files[join(name, sub)] = text;
    } else if (/\.(m?js|css|html)$/.test(name)) {
      files[name] = readFileSync(path, "utf8");
    }
  }
  return files;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? ".output/public/assets";
  let files;
  try {
    files = readAssets(dir);
  } catch {
    console.error(`client-bundle-guard: no ${dir}; build first (npm run build:node).`);
    process.exit(2);
  }
  if (Object.keys(files).length === 0) {
    console.error(`client-bundle-guard: ${dir} holds no assets; build first.`);
    process.exit(2);
  }
  const hits = findServerCode(files);
  if (hits.length) {
    for (const { file, marker } of hits) console.error(`server code in the client bundle: ${marker} in ${file}`);
    process.exit(1);
  }
  console.log(`client-bundle-guard: ${Object.keys(files).length} client assets, no server code.`);
}
