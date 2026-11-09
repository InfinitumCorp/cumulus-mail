import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  LOCK_PATH,
  assertChecksumMatch,
  fetchGeoDatasets,
  parseFetchArgs,
  parseSha256Sum,
  readLock,
} from "./fetch-geo-dat.mjs";

const GEOIP_HASH = "eedb24b3b9fcba27e06b92c0428dab90d9496083091ae4cf39e11387fd99d0e2";
const GEOSITE_HASH = "dc4192dd1b644a38276ed06136d26e729fa674d25785adb38c87e040e92376b2";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function response(body, status = 200) {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => new TextDecoder().decode(bytes),
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

test("parseSha256Sum reads the official asset line", () => {
  assert.equal(parseSha256Sum(`${GEOIP_HASH}  geoip.dat\n`, "geoip.dat"), GEOIP_HASH);
  assert.equal(parseSha256Sum(`${GEOSITE_HASH} *dlc.dat\n`, "dlc.dat"), GEOSITE_HASH);
  assert.throws(() => parseSha256Sum("nope\n", "geoip.dat"), /not a hash/);
  assert.throws(() => parseSha256Sum(`${GEOIP_HASH}  other.dat\n`, "geoip.dat"), /other\.dat/);
});

test("assertChecksumMatch stops when the official sum or the bytes differ", () => {
  assert.throws(
    () => assertChecksumMatch({ published: "aa", locked: "bb", actual: "bb", name: "geoip.dat" }),
    /official sha256sum/,
  );
  assert.throws(
    () =>
      assertChecksumMatch({
        published: GEOIP_HASH,
        locked: GEOIP_HASH,
        actual: "ff",
        name: "geoip.dat",
      }),
    /downloaded sha256/,
  );
  assert.doesNotThrow(() =>
    assertChecksumMatch({
      published: GEOIP_HASH,
      locked: GEOIP_HASH,
      actual: GEOIP_HASH,
      name: "geoip.dat",
    }),
  );
});

test("the lockfile pins the verified v2fly releases", () => {
  const lock = readLock(LOCK_PATH);
  assert.deepEqual(
    lock.datasets.map((item) => [
      item.name,
      item.project,
      item.tag,
      item.asset,
      item.sha256,
      item.license,
    ]),
    [
      ["geoip.dat", "v2fly/geoip", "202611080027", "geoip.dat", GEOIP_HASH, "CC-BY-SA-4.0"],
      [
        "geosite.dat",
        "v2fly/domain-list-community",
        "20261108011013",
        "dlc.dat",
        GEOSITE_HASH,
        "MIT",
      ],
    ],
  );
  for (const item of lock.datasets) {
    assert.equal(item.url.startsWith("https://github.com/v2fly/"), true);
    assert.equal(item.sha256Url, `${item.url}.sha256sum`);
  }
});

test("readLock refuses Loyalsoldier and sing-box URLs", () => {
  const dir = mkdtempSync(join(tmpdir(), "cumulus-geo-lock-"));
  const path = join(dir, "lock.json");
  const base = readLock(LOCK_PATH);
  base.datasets[0].url =
    "https://github.com/Loyalsoldier/v2ray-rules-dat/releases/download/x/geoip.dat";
  writeFileSync(path, JSON.stringify(base));
  assert.throws(() => readLock(path), /refusing a non-v2fly dataset/);
  base.datasets[0].url = "https://github.com/v2fly/geoip/releases/download/202611080027/geoip.dat";
  base.datasets[1].url = "https://github.com/SagerNet/sing-box/releases/download/x/geoip.dat";
  writeFileSync(path, JSON.stringify(base));
  assert.throws(() => readLock(path), /refusing a non-v2fly dataset/);
  rmSync(dir, { recursive: true, force: true });
});

test("parseFetchArgs accepts an optional destination", () => {
  assert.equal(typeof parseFetchArgs([]).dest, "string");
  assert.equal(
    parseFetchArgs(["--dest", "data/geo"]).dest.endsWith(`${join("data", "geo")}`),
    true,
  );
  assert.match(parseFetchArgs(["--weird"]).error, /unexpected argument/);
});

test("fetch writes verified files and deletes nothing already good when a sum mismatches", async () => {
  const geoip = Buffer.from("geoip-bytes");
  const geosite = Buffer.from("geosite-bytes");
  const lock = {
    datasets: [
      {
        name: "geoip.dat",
        project: "v2fly/geoip",
        tag: "test",
        asset: "geoip.dat",
        url: "https://github.com/v2fly/geoip/geoip.dat",
        sha256Url: "https://github.com/v2fly/geoip/geoip.dat.sha256sum",
        sha256: sha256(geoip),
        license: "CC-BY-SA-4.0",
      },
      {
        name: "geosite.dat",
        project: "v2fly/domain-list-community",
        tag: "test",
        asset: "dlc.dat",
        url: "https://github.com/v2fly/domain-list-community/dlc.dat",
        sha256Url: "https://github.com/v2fly/domain-list-community/dlc.dat.sha256sum",
        sha256: sha256(geosite),
        license: "MIT",
      },
    ],
  };
  const files = new Map([
    [lock.datasets[0].sha256Url, `${lock.datasets[0].sha256}  geoip.dat\n`],
    [lock.datasets[0].url, geoip],
    [lock.datasets[1].sha256Url, `${lock.datasets[1].sha256}  dlc.dat\n`],
    [lock.datasets[1].url, geosite],
  ]);
  const fetchImpl = async (url) => {
    const body = files.get(url);
    if (!body) return response("", 404);
    return response(body);
  };
  const dest = mkdtempSync(join(tmpdir(), "cumulus-geo-fetch-"));
  try {
    const written = await fetchGeoDatasets({ lock, destDir: dest, fetchImpl });
    assert.deepEqual(readFileSync(written[0]), geoip);
    assert.deepEqual(readFileSync(join(dest, "geosite.dat")), geosite);
    assert.equal(
      readdirSync(dest).some((name) => name.includes("partial")),
      false,
    );

    const bad = {
      datasets: [
        {
          ...lock.datasets[0],
          sha256: "a".repeat(64),
        },
      ],
    };
    files.set(bad.datasets[0].sha256Url, `${GEOIP_HASH}  geoip.dat\n`);
    writeFileSync(join(dest, "geoip.dat"), Buffer.from("keep"));
    await assert.rejects(
      () => fetchGeoDatasets({ lock: bad, destDir: dest, fetchImpl }),
      /official sha256sum/,
    );
    assert.equal(readFileSync(join(dest, "geoip.dat"), "utf8"), "keep");
    assert.equal(existsSync(join(dest, ".geoip.dat.partial")), false);

    files.set(lock.datasets[0].sha256Url, `${lock.datasets[0].sha256}  geoip.dat\n`);
    files.set(lock.datasets[0].url, Buffer.from("tampered"));
    await assert.rejects(
      () => fetchGeoDatasets({ lock: { datasets: [lock.datasets[0]] }, destDir: dest, fetchImpl }),
      /downloaded sha256/,
    );
    assert.equal(readFileSync(join(dest, "geoip.dat"), "utf8"), "keep");
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});
