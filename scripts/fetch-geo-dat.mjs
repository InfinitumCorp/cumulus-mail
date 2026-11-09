#!/usr/bin/env node
/**
 * Download the pinned v2fly geoip.dat and geosite.dat files into data/geo.
 *
 * The lockfile records the release tag, URL, and SHA-256. Each run fetches
 * the official .sha256sum asset first. A mismatch with the lockfile, or a
 * downloaded file whose digest differs, stops the run and leaves no partial
 * binary in place. The .dat files are gitignored and must not be committed.
 *
 *   node scripts/fetch-geo-dat.mjs
 *   node scripts/fetch-geo-dat.mjs --dest data/geo
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const LOCK_PATH = join(dirname(fileURLToPath(import.meta.url)), "geo-dat.lock.json");
export const DEFAULT_GEO_DIR = join(ROOT, "data", "geo");

const REQUIRED = ["name", "project", "tag", "asset", "url", "sha256Url", "sha256", "license"];

export function parseSha256Sum(text, assetName) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (lines.length === 0) throw new Error("sha256sum file is empty");
  const parsed = lines.map((line) => {
    const match = /^([a-f0-9]{64})(?:\s+\*?(\S+))?$/i.exec(line);
    if (!match) throw new Error(`sha256sum line is not a hash: ${line}`);
    return { hash: match[1].toLowerCase(), name: match[2] };
  });
  const named = assetName ? parsed.find((row) => row.name === assetName) : undefined;
  const chosen = named ?? (parsed.length === 1 ? parsed[0] : undefined);
  if (!chosen) throw new Error(`sha256sum file has no entry for ${assetName}`);
  if (chosen.name && assetName && chosen.name !== assetName) {
    throw new Error(`sha256sum names ${chosen.name}, expected ${assetName}`);
  }
  return chosen.hash;
}

export function assertChecksumMatch({ published, locked, actual, name }) {
  if (published !== locked) {
    throw new Error(`${name}: official sha256sum ${published} does not match lockfile ${locked}`);
  }
  if (actual !== locked) {
    throw new Error(`${name}: downloaded sha256 ${actual} does not match lockfile ${locked}`);
  }
}

function rejectForeignSource(item) {
  const haystack = `${item.project} ${item.url} ${item.sha256Url}`.toLowerCase();
  if (
    haystack.includes("loyalsoldier") ||
    haystack.includes("sing-box") ||
    haystack.includes("singbox") ||
    haystack.includes("sagernet")
  ) {
    throw new Error(`${item.name}: refusing a non-v2fly dataset`);
  }
  if (
    !item.url.startsWith("https://github.com/v2fly/") ||
    !item.sha256Url.startsWith("https://github.com/v2fly/")
  ) {
    throw new Error(`${item.name}: only v2fly release URLs are allowed`);
  }
}

export function readLock(path = LOCK_PATH) {
  const lock = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(lock.datasets) || lock.datasets.length === 0) {
    throw new Error("lockfile has no datasets");
  }
  for (const item of lock.datasets) {
    for (const key of REQUIRED) {
      if (typeof item[key] !== "string" || item[key].trim() === "") {
        throw new Error(`lock entry missing ${key}`);
      }
    }
    if (!/^[a-f0-9]{64}$/.test(item.sha256)) {
      throw new Error(`${item.name}: lockfile sha256 is not 64 hex chars`);
    }
    item.sha256 = item.sha256.toLowerCase();
    rejectForeignSource(item);
  }
  return lock;
}

export function parseFetchArgs(argv) {
  let dest = DEFAULT_GEO_DIR;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dest") {
      const value = argv[index + 1];
      if (!value) return { error: "usage: node scripts/fetch-geo-dat.mjs [--dest <dir>]" };
      dest = resolve(value);
      index += 1;
      continue;
    }
    return { error: `unexpected argument: ${arg}` };
  }
  return { dest };
}

async function readBody(response) {
  if (typeof response.arrayBuffer === "function")
    return new Uint8Array(await response.arrayBuffer());
  if (response.body) return new Uint8Array(await new Response(response.body).arrayBuffer());
  throw new Error("download response has no body");
}

export async function fetchGeoDatasets({ lock, destDir, fetchImpl = globalThis.fetch }) {
  mkdirSync(destDir, { recursive: true });
  const written = [];
  for (const item of lock.datasets) {
    const sumResponse = await fetchImpl(item.sha256Url);
    if (!sumResponse.ok) {
      throw new Error(`${item.name}: sha256sum download failed (${sumResponse.status})`);
    }
    const sumText =
      typeof sumResponse.text === "function"
        ? await sumResponse.text()
        : new TextDecoder().decode(await readBody(sumResponse));
    const published = parseSha256Sum(sumText, item.asset);
    if (published !== item.sha256) {
      throw new Error(
        `${item.name}: official sha256sum ${published} does not match lockfile ${item.sha256}`,
      );
    }
    const binResponse = await fetchImpl(item.url);
    if (!binResponse.ok) throw new Error(`${item.name}: download failed (${binResponse.status})`);
    const bytes = Buffer.from(await readBody(binResponse));
    const actual = createHash("sha256").update(bytes).digest("hex");
    assertChecksumMatch({ published, locked: item.sha256, actual, name: item.name });
    const partial = join(destDir, `.${item.name}.partial`);
    const finalPath = join(destDir, item.name);
    let committed = false;
    try {
      writeFileSync(partial, bytes);
      renameSync(partial, finalPath);
      committed = true;
    } finally {
      if (!committed) rmSync(partial, { force: true });
    }
    written.push(finalPath);
  }
  return written;
}

async function main() {
  const args = parseFetchArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`[fetch-geo-dat] ${args.error}`);
    process.exit(1);
  }
  const lock = readLock(LOCK_PATH);
  const written = await fetchGeoDatasets({ lock, destDir: args.dest });
  for (const path of written) console.log(`[fetch-geo-dat] verified ${path}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[fetch-geo-dat] ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
