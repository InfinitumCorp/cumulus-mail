#!/usr/bin/env node
/**
 * Download v2fly geoip.dat and geosite.dat into .data/geo.
 *
 * The lockfile (geo.lock.json) records the release tag, URL, and SHA-256.
 * Each download is checked against the official .sha256sum asset and against
 * the lockfile. A mismatch throws and does not leave the file in place.
 *
 * The .dat files are gitignored. Do not commit them.
 * Loyalsoldier and sing-box sets are GPL-3 and are not accepted here.
 */
import { createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";

const here = dirname(fileURLToPath(import.meta.url));
export const lockPath = join(here, "geo.lock.json");
export const defaultDestDir = join(here, "..", "..", ".data", "geo");

export class ChecksumMismatch extends Error {
  constructor(message) {
    super(message);
    this.name = "ChecksumMismatch";
  }
}

export function parseSha256Sum(text, filename) {
  const wanted = filename.trim();
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
    if (match && match[2] === wanted) return match[1].toLowerCase();
  }
  throw new ChecksumMismatch(`official checksum has no entry for ${wanted}`);
}

export function assertHttps(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error(`refusing non-https URL ${url}`);
  return parsed;
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Official sum, lockfile sum, and downloaded bytes must all be the same hash.
 * Returns the hex digest. Throws ChecksumMismatch otherwise.
 */
export function verifyBytes({ lockSha256, officialText, checksumName, body }) {
  const official = parseSha256Sum(officialText, checksumName);
  const locked = String(lockSha256).trim().toLowerCase();
  if (official !== locked) {
    throw new ChecksumMismatch(
      `lockfile SHA-256 for ${checksumName} does not match the official .sha256sum\nlock ${locked}\nofficial ${official}`,
    );
  }
  const got = sha256Hex(body);
  if (got !== official) {
    throw new ChecksumMismatch(
      `downloaded ${checksumName} SHA-256 does not match the official .sha256sum\ngot ${got}\nofficial ${official}`,
    );
  }
  return got;
}

async function readBody(response, url) {
  if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function fetchAsset(asset, destDir, fetchImpl = globalThis.fetch) {
  assertHttps(asset.url);
  assertHttps(asset.sha256sumUrl);
  const sumResponse = await fetchImpl(asset.sha256sumUrl);
  const officialText = (await readBody(sumResponse, asset.sha256sumUrl)).toString("utf8");
  const dataResponse = await fetchImpl(asset.url);
  const body = await readBody(dataResponse, asset.url);
  const digest = verifyBytes({
    lockSha256: asset.sha256,
    officialText,
    checksumName: asset.checksumName,
    body,
  });
  await mkdir(destDir, { recursive: true });
  const target = join(destDir, asset.file);
  const staging = `${target}.partial`;
  await writeFile(staging, body);
  await rename(staging, target);
  return { file: target, sha256: digest };
}

export async function loadLock(path = lockPath) {
  const lock = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(lock.assets) || lock.assets.length === 0) {
    throw new Error("geo lockfile has no assets");
  }
  return lock;
}

export async function fetchLocked(destDir = defaultDestDir, fetchImpl = globalThis.fetch) {
  const lock = await loadLock();
  const written = [];
  for (const asset of lock.assets) {
    if (/loyalsoldier|sing-box|singbox/i.test(`${asset.url} ${asset.project ?? ""}`)) {
      throw new Error(`refusing GPL-3 geo set: ${asset.url}`);
    }
    written.push(await fetchAsset(asset, destDir, fetchImpl));
  }
  return written;
}

function invokedDirectly() {
  const arg = process.argv[1];
  if (!arg) return false;
  return import.meta.url === pathToFileURL(resolve(arg)).href;
}

if (invokedDirectly()) {
  const dest = process.env.INFINITUM_GEO_DIR?.trim() || defaultDestDir;
  fetchLocked(dest)
    .then((written) => {
      for (const item of written) console.log(`wrote ${item.file} ${item.sha256}`);
    })
    .catch(async (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      const partial = join(dest, "geoip.dat.partial");
      const partialSite = join(dest, "geosite.dat.partial");
      await rm(partial, { force: true }).catch(() => undefined);
      await rm(partialSite, { force: true }).catch(() => undefined);
      process.exit(1);
    });
}
