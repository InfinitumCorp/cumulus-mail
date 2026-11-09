import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ChecksumMismatch,
  fetchAsset,
  loadLock,
  lockPath,
  parseSha256Sum,
  verifyBytes,
} from "./fetch-geo.mjs";

const GEOIP = "eedb24b3b9fcba27e06b92c0428dab90d9496083091ae4cf39e11387fd99d0e2";
const GEOSITE = "dc4192dd1b644a38276ed06136d26e729fa674d25785adb38c87e040e92376b2";

test("the lockfile points only at the pinned v2fly releases", async () => {
  const lock = await loadLock(lockPath);
  assert.equal(lock.assets.length, 2);
  const [geoip, geosite] = lock.assets;
  assert.equal(geoip.file, "geoip.dat");
  assert.equal(geoip.tag, "202611080027");
  assert.equal(geoip.sha256, GEOIP);
  assert.equal(geoip.license, "CC-BY-SA-4.0");
  assert.match(
    geoip.url,
    /^https:\/\/github\.com\/v2fly\/geoip\/releases\/download\/202611080027\/geoip\.dat$/,
  );
  assert.equal(geosite.file, "geosite.dat");
  assert.equal(geosite.tag, "20261108011013");
  assert.equal(geosite.sha256, GEOSITE);
  assert.equal(geosite.license, "MIT");
  assert.match(
    geosite.url,
    /^https:\/\/github\.com\/v2fly\/domain-list-community\/releases\/download\/20261108011013\/dlc\.dat$/,
  );
  for (const asset of lock.assets) {
    assert.equal(/loyalsoldier|sing-box|singbox/i.test(`${asset.url} ${asset.project}`), false);
    assert.match(asset.sha256sumUrl, /^https:\/\/github\.com\/v2fly\//);
  }
});

test("official checksum lines can name the file with or without a star", () => {
  assert.equal(parseSha256Sum(`${GEOIP}  geoip.dat\n`, "geoip.dat"), GEOIP);
  assert.equal(parseSha256Sum(`${GEOSITE} *dlc.dat\n`, "dlc.dat"), GEOSITE);
  assert.throws(() => parseSha256Sum(`${GEOIP}  other.dat\n`, "geoip.dat"), ChecksumMismatch);
});

test("a lockfile hash that disagrees with the official sum stops before use", () => {
  assert.throws(
    () =>
      verifyBytes({
        lockSha256: "ab".repeat(32),
        officialText: `${GEOIP}  geoip.dat\n`,
        checksumName: "geoip.dat",
        body: Buffer.from("ignored"),
      }),
    /lockfile SHA-256/,
  );
});

test("a downloaded body that disagrees with the official sum is not written", async () => {
  const dir = await mkdtemp(join(tmpdir(), "geo-fetch-"));
  const body = Buffer.from("not the dataset");
  const fetchImpl = async (url) => {
    const payload = String(url).endsWith(".sha256sum")
      ? Buffer.from(`${GEOIP}  geoip.dat\n`)
      : body;
    return new Response(payload, { status: 200 });
  };
  await assert.rejects(
    () =>
      fetchAsset(
        {
          file: "geoip.dat",
          url: "https://github.com/v2fly/geoip/releases/download/202611080027/geoip.dat",
          sha256sumUrl:
            "https://github.com/v2fly/geoip/releases/download/202611080027/geoip.dat.sha256sum",
          checksumName: "geoip.dat",
          sha256: GEOIP,
        },
        dir,
        fetchImpl,
      ),
    ChecksumMismatch,
  );
  await assert.rejects(readFile(join(dir, "geoip.dat")));
  await rm(dir, { recursive: true, force: true });
});

test("matching sums write geoip.dat and keep dlc.dat under the geosite name", async () => {
  const dir = await mkdtemp(join(tmpdir(), "geo-fetch-ok-"));
  const body = Buffer.from("synthetic-geo");
  const { createHash } = await import("node:crypto");
  const digest = createHash("sha256").update(body).digest("hex");
  const fetchImpl = async (url) => {
    const name = String(url).includes("dlc.dat") ? "dlc.dat" : "geoip.dat";
    const payload = String(url).endsWith(".sha256sum") ? Buffer.from(`${digest}  ${name}\n`) : body;
    return new Response(payload, { status: 200 });
  };
  const written = await fetchAsset(
    {
      file: "geosite.dat",
      url: "https://github.com/v2fly/domain-list-community/releases/download/20261108011013/dlc.dat",
      sha256sumUrl:
        "https://github.com/v2fly/domain-list-community/releases/download/20261108011013/dlc.dat.sha256sum",
      checksumName: "dlc.dat",
      sha256: digest,
    },
    dir,
    fetchImpl,
  );
  assert.equal(written.sha256, digest);
  assert.equal((await readFile(join(dir, "geosite.dat"))).equals(body), true);
  await rm(dir, { recursive: true, force: true });
});
