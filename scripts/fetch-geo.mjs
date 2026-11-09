#!/usr/bin/env node
/**
 * Download the locked v2fly geoip.dat and geosite.dat files into data/geo/.
 *
 * Each file is checked against its official .sha256sum asset and the SHA-256
 * in data/geo/geo.lock.json. A mismatch throws and does not write that file.
 * The binaries are gitignored. Loyalsoldier and sing-box datasets are refused.
 *
 *   node scripts/fetch-geo.mjs [--lock data/geo/geo.lock.json] [--dest data/geo]
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BANNED = ["loyalsoldier", "sing-box", "singbox", "sagernet"];
const ALLOWED_REPOS = new Set(["geoip", "domain-list-community"]);
const SAVED_NAMES = new Set(["geoip.dat", "geosite.dat"]);

/**
 * @param {string[]} argv
 * @returns {{ lock: string, dest: string } | { error: string }}
 */
export function parseFetchGeoArgs(argv) {
  let lock = join(ROOT, "data/geo/geo.lock.json");
  let dest = join(ROOT, "data/geo");
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--lock") {
      const value = argv[++i];
      if (!value)
        return { error: "usage: node scripts/fetch-geo.mjs [--lock <file>] [--dest <dir>]" };
      lock = resolve(value);
      continue;
    }
    if (arg === "--dest") {
      const value = argv[++i];
      if (!value)
        return { error: "usage: node scripts/fetch-geo.mjs [--lock <file>] [--dest <dir>]" };
      dest = resolve(value);
      continue;
    }
    return { error: `unexpected argument: ${arg}` };
  }
  return { lock, dest };
}

/**
 * @param {unknown} entry
 */
export function assertAllowedDataset(entry) {
  if (!entry || typeof entry !== "object") throw new Error("geo lockfile entry is not an object");
  const row = /** @type {Record<string, unknown>} */ (entry);
  const name = String(row.name ?? "");
  const blob = JSON.stringify(row).toLowerCase();
  for (const banned of BANNED) {
    if (blob.includes(banned)) throw new Error(`refusing ${banned} geo data; v2fly datasets only`);
  }
  if (!SAVED_NAMES.has(name))
    throw new Error(`unexpected geo dataset name: ${name || "(missing)"}`);
  if (typeof row.tag !== "string" || !row.tag.trim())
    throw new Error(`${name} lockfile is missing a tag`);
  if (
    typeof row.asset !== "string" ||
    !row.asset.trim() ||
    row.asset.includes("/") ||
    row.asset.includes("..")
  ) {
    throw new Error(`${name} lockfile is missing an asset name`);
  }
  if (typeof row.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(row.sha256)) {
    throw new Error(`${name} lockfile SHA-256 is invalid`);
  }
  for (const key of ["url", "sha256Url"]) {
    if (typeof row[key] !== "string" || !row[key])
      throw new Error(`${name} lockfile is missing ${key}`);
    const url = new URL(String(row[key]));
    if (url.protocol !== "https:") throw new Error(`${name} URL must be https`);
    if (url.hostname !== "github.com")
      throw new Error(`${name} must be downloaded from github.com`);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "v2fly" || !ALLOWED_REPOS.has(parts[1] ?? "")) {
      throw new Error(`${name} must come from v2fly/geoip or v2fly/domain-list-community`);
    }
  }
}

/**
 * @param {string} text
 * @returns {{ source: string, datasets: Array<Record<string, string>> }}
 */
export function readLockfile(text) {
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.datasets) || data.datasets.length === 0) {
    throw new Error("geo lockfile has no datasets");
  }
  for (const entry of data.datasets) assertAllowedDataset(entry);
  return data;
}

/**
 * @param {string} text
 * @param {string} assetName
 * @returns {string}
 */
export function parseOfficialSha256(text, assetName) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const match = /^([0-9a-fA-F]{64})(?:\s+\*?(\S+))?$/.exec(line);
    if (!match) continue;
    const fileName = match[2];
    if (fileName === assetName || fileName?.endsWith(`/${assetName}`))
      return match[1].toLowerCase();
  }
  throw new Error(`official sha256sum has no entry for ${assetName}`);
}

/**
 * @param {Record<string, string>} entry
 * @param {string} destDir
 * @param {typeof fetch} fetchImpl
 */
export async function fetchLockedDataset(entry, destDir, fetchImpl = globalThis.fetch) {
  assertAllowedDataset(entry);
  const sumResponse = await fetchImpl(entry.sha256Url);
  if (!sumResponse.ok)
    throw new Error(`sha256sum download failed for ${entry.name} (${sumResponse.status})`);
  const official = parseOfficialSha256(await sumResponse.text(), entry.asset);
  if (official !== entry.sha256) {
    throw new Error(
      `official sha256sum for ${entry.name} does not match the lockfile\n  lockfile: ${entry.sha256}\n  official: ${official}`,
    );
  }
  const dataResponse = await fetchImpl(entry.url);
  if (!dataResponse.ok)
    throw new Error(`download failed for ${entry.name} (${dataResponse.status})`);
  const bytes = new Uint8Array(await dataResponse.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== entry.sha256) {
    throw new Error(
      `checksum mismatch for ${entry.name}\n  lockfile: ${entry.sha256}\n  download: ${actual}`,
    );
  }
  await mkdir(destDir, { recursive: true });
  const target = join(destDir, entry.name);
  const partial = `${target}.partial`;
  await writeFile(partial, bytes);
  await rename(partial, target);
}

/**
 * @param {{ datasets: Array<Record<string, string>> }} lock
 * @param {string} destDir
 * @param {typeof fetch} [fetchImpl]
 */
export async function fetchLockedDatasets(lock, destDir, fetchImpl = globalThis.fetch) {
  for (const entry of lock.datasets) {
    await fetchLockedDataset(entry, destDir, fetchImpl);
  }
}

async function main() {
  const parsed = parseFetchGeoArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(parsed.error);
    process.exitCode = 1;
    return;
  }
  const lock = readLockfile(await readFile(parsed.lock, "utf8"));
  await fetchLockedDatasets(lock, parsed.dest);
  for (const entry of lock.datasets) {
    console.log(`[geo] wrote ${join(parsed.dest, entry.name)} ${entry.tag} ${entry.sha256}`);
  }
}

const invoked = Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
if (invoked) {
  main().catch((error) => {
    console.error(`[geo] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
