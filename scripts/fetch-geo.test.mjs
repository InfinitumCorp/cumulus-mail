import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertAllowedDataset,
  fetchLockedDataset,
  parseFetchGeoArgs,
  parseOfficialSha256,
  readLockfile,
} from "./fetch-geo.mjs";

const LOCK = JSON.parse(
  readFileSync(new URL("../data/geo/geo.lock.json", import.meta.url), "utf8"),
);

function response(body, status = 200) {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return new TextDecoder().decode(bytes);
    },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

test("the lockfile pins the verified v2fly releases and refuses other sources", () => {
  const lock = readLockfile(JSON.stringify(LOCK));
  assert.deepEqual(
    lock.datasets.map((entry) => [entry.name, entry.tag, entry.asset, entry.sha256]),
    [
      [
        "geoip.dat",
        "202611080027",
        "geoip.dat",
        "eedb24b3b9fcba27e06b92c0428dab90d9496083091ae4cf39e11387fd99d0e2",
      ],
      [
        "geosite.dat",
        "20261108011013",
        "dlc.dat",
        "dc4192dd1b644a38276ed06136d26e729fa674d25785adb38c87e040e92376b2",
      ],
    ],
  );
  assert.equal(
    parseOfficialSha256(
      "eedb24b3b9fcba27e06b92c0428dab90d9496083091ae4cf39e11387fd99d0e2  geoip.dat\n",
      "geoip.dat",
    ),
    LOCK.datasets[0].sha256,
  );
  assert.throws(
    () =>
      assertAllowedDataset({
        ...LOCK.datasets[0],
        url: "https://github.com/Loyalsoldier/v2ray-rules-dat/releases/download/x/geoip.dat",
      }),
    /loyalsoldier/,
  );
  assert.throws(
    () =>
      assertAllowedDataset({
        ...LOCK.datasets[1],
        url: "https://github.com/SagerNet/sing-box/releases/download/x/geoip.dat",
      }),
    /sing-box/,
  );
  assert.match(parseFetchGeoArgs(["--nope"]).error, /unexpected argument: --nope/);
});

test("a checksum mismatch writes nothing and an official match writes the dataset", async () => {
  const dest = mkdtempSync(join(tmpdir(), "geo-fetch-"));
  const entry = {
    ...LOCK.datasets[0],
    url: "https://github.com/v2fly/geoip/releases/download/202611080027/geoip.dat",
    sha256Url: "https://github.com/v2fly/geoip/releases/download/202611080027/geoip.dat.sha256sum",
  };
  const bytes = new TextEncoder().encode("synthetic-geoip");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (String(url).endsWith(".sha256sum"))
      return response(
        `abcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcd  geoip.dat\n`,
      );
    return response(bytes);
  };
  await assert.rejects(
    () => fetchLockedDataset(entry, dest, fetchImpl),
    /does not match the lockfile/,
  );
  assert.equal(
    calls.some((url) => String(url).endsWith("geoip.dat")),
    false,
  );
  assert.deepEqual(readdirSync(dest), []);

  const matching = { ...entry, sha256: hash };
  calls.length = 0;
  const badFile = async (url) => {
    calls.push(url);
    if (String(url).endsWith(".sha256sum")) return response(`${hash}  geoip.dat\n`);
    return response(new TextEncoder().encode("different-bytes"));
  };
  await assert.rejects(() => fetchLockedDataset(matching, dest, badFile), /checksum mismatch/);
  assert.deepEqual(readdirSync(dest), []);

  const goodFile = async (url) => {
    if (String(url).endsWith(".sha256sum")) return response(`${hash}  geoip.dat\n`);
    return response(bytes);
  };
  await fetchLockedDataset(matching, dest, goodFile);
  assert.deepEqual(readdirSync(dest), ["geoip.dat"]);
  assert.equal(readFileSync(join(dest, "geoip.dat"), "utf8"), "synthetic-geoip");
});
