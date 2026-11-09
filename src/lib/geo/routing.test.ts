import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { exportMailbox, importMailbox } from "../mail/backup.ts";
import { ingestInboundEmail } from "../mail/inbound.ts";
import { openMailbox, writeSnapshot } from "../mail/mailbox.ts";
import { readSnapshot } from "../mail/records.ts";
import { createHarness, profile } from "../mail/test-support.ts";
import { DomainType } from "./dat.ts";
import { cidr, domainRule, geoipEntry, geoipList, geositeEntry, geositeList } from "./fixture.ts";
import { resetGeoCache } from "./runtime.ts";

let harness: Awaited<ReturnType<typeof createHarness>>;

before(async () => {
  harness = await createHarness();
});

after(async () => {
  await harness.close();
});

const RAW = [
  "From: Ada <ada@mail.example.test>",
  "To: Bea <geo.bea@cumuluscloud.app>",
  "Subject: Hello",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Notes.",
  "",
].join("\r\n");

async function withGeoEnv(dir: string, enabled: boolean, run: () => Promise<void>) {
  const previousEnabled = process.env.INFINITUM_GEO_ENABLED;
  const previousDir = process.env.INFINITUM_GEO_DIR;
  const originalInfo = console.info;
  const lines: string[] = [];
  process.env.INFINITUM_GEO_ENABLED = enabled ? "true" : "";
  process.env.INFINITUM_GEO_DIR = dir;
  console.info = (...args: unknown[]) => {
    lines.push(args.map((item) => String(item)).join(" "));
  };
  resetGeoCache();
  try {
    await run();
  } finally {
    if (previousEnabled === undefined) delete process.env.INFINITUM_GEO_ENABLED;
    else process.env.INFINITUM_GEO_ENABLED = previousEnabled;
    if (previousDir === undefined) delete process.env.INFINITUM_GEO_DIR;
    else process.env.INFINITUM_GEO_DIR = previousDir;
    console.info = originalInfo;
    resetGeoCache();
  }
  return lines;
}

test("the geo routing switch persists and round-trips in a backup", async () => {
  const { db, storageFor } = harness;
  const ada = profile("geo-ada", "geo.ada@cumuluscloud.app", "Ada");
  const opened = await openMailbox(db, "geo-ada", ada);
  assert.equal(opened.geoRouting, false);
  const saved = await writeSnapshot(db, storageFor, "geo-ada", { ...opened, geoRouting: true });
  assert.equal(saved.geoRouting, true);
  assert.equal((await readSnapshot(db, "geo-ada")).geoRouting, true);

  const backup = await exportMailbox(db, storageFor("geo-ada"), "geo-ada");
  assert.equal(backup.geoRouting, true);
  await writeSnapshot(db, storageFor, "geo-ada", { ...saved, geoRouting: false });
  assert.equal((await readSnapshot(db, "geo-ada")).geoRouting, false);
  const restored = await importMailbox(db, storageFor, "geo-ada", backup);
  assert.equal(restored.geoRouting, true);
});

test("inbound mail is unchanged when geo routing is off and annotated when both switches are on", async () => {
  const { db, storageFor } = harness;
  const bea = profile("geo-bea", "geo.bea@cumuluscloud.app", "Bea");
  const opened = await openMailbox(db, "geo-bea", bea);
  await writeSnapshot(db, storageFor, "geo-bea", { ...opened, geoRouting: true });
  const dir = await mkdtemp(join(tmpdir(), "cumulus-geo-"));
  await writeFile(
    join(dir, "geoip.dat"),
    geoipList([geoipEntry("ZZ", [cidr([203, 0, 113, 0], 24)])]),
  );
  await writeFile(
    join(dir, "geosite.dat"),
    geositeList([geositeEntry("example", [domainRule(DomainType.Domain, "example.test")])]),
  );
  const raw = new TextEncoder().encode(RAW);
  try {
    const quiet = await withGeoEnv(dir, false, async () => {
      await ingestInboundEmail(db, storageFor, {
        from: "ada@mail.example.test",
        to: "geo.bea@cumuluscloud.app",
        raw,
        receivedIp: "203.0.113.9",
      });
    });
    assert.deepEqual(quiet, []);
    const off = (await readSnapshot(db, "geo-bea")).messages.find(
      (item) => item.subject === "Hello",
    );
    assert.ok(off);
    assert.deepEqual(off.labels, []);
    assert.equal(off.folder, "inbox");

    const loud = await withGeoEnv(dir, true, async () => {
      await ingestInboundEmail(db, storageFor, {
        from: "ada@mail.example.test",
        to: "geo.bea@cumuluscloud.app",
        raw: new TextEncoder().encode(RAW.replace("Hello", "Hello again")),
        receivedIp: "203.0.113.9",
      });
    });
    const on = (await readSnapshot(db, "geo-bea")).messages.find(
      (item) => item.subject === "Hello again",
    );
    assert.ok(on);
    assert.deepEqual(on.labels, ["geo:ZZ", "site:example"]);
    assert.equal(on.folder, "inbox");
    assert.equal(on.body, "Notes.");
    assert.ok(loud.some((line) => line.includes("geo route country=ZZ categories=example")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
