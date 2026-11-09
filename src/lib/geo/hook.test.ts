import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { applyGeoHook, geoPolicy, infinitumGeoEnabled, resetGeoHook } from "./hook.ts";
import { loadGeoLists, resetGeoCache } from "./load.ts";
import { ingestInboundEmail } from "../mail/inbound.ts";
import { openMailbox, writeSnapshot } from "../mail/mailbox.ts";
import { readSnapshot } from "../mail/records.ts";
import { openText } from "../mail/field-crypto.ts";
import { createHarness, profile } from "../mail/test-support.ts";
import type { MailMessage } from "../mail/model.ts";

const fixtureDir = fileURLToPath(new URL("./fixtures/", import.meta.url));

const RAW = [
  "From: Mira Chen <mira.chen@cumuluscloud.app>",
  "To: Ada <geo.ada@cumuluscloud.app>",
  "Subject: Notes",
  "Content-Type: text/plain",
  "",
  "Hello from outside.",
  "",
].join("\r\n");

function letter(partial: Partial<MailMessage> & Pick<MailMessage, "id">): MailMessage {
  return {
    threadId: partial.id,
    folder: "inbox",
    from: { name: "Mira", email: "mira.chen@cumuluscloud.app" },
    to: [{ name: "Ada", email: "geo.ada@cumuluscloud.app" }],
    cc: [],
    subject: "Notes",
    body: "Hello from outside.",
    at: "2026-11-08T12:00:00.000Z",
    unread: true,
    starred: false,
    labels: [],
    ...partial,
  };
}

describe("geo hook", { concurrency: false }, () => {
  let harness: Awaited<ReturnType<typeof createHarness>>;
  const previous = {
    enabled: process.env.INFINITUM_GEO_ENABLED,
    dir: process.env.INFINITUM_GEO_DIR,
  };

  before(async () => {
    harness = await createHarness();
  });

  after(async () => {
    if (previous.enabled === undefined) delete process.env.INFINITUM_GEO_ENABLED;
    else process.env.INFINITUM_GEO_ENABLED = previous.enabled;
    if (previous.dir === undefined) delete process.env.INFINITUM_GEO_DIR;
    else process.env.INFINITUM_GEO_DIR = previous.dir;
    resetGeoHook();
    await harness.close();
  });

  test("the server flag is off unless it is an explicit on value", () => {
    const saved = process.env.INFINITUM_GEO_ENABLED;
    delete process.env.INFINITUM_GEO_ENABLED;
    assert.equal(infinitumGeoEnabled(), false);
    process.env.INFINITUM_GEO_ENABLED = "0";
    assert.equal(infinitumGeoEnabled(), false);
    process.env.INFINITUM_GEO_ENABLED = "false";
    assert.equal(infinitumGeoEnabled(), false);
    assert.equal(infinitumGeoEnabled("yes"), true);
    assert.equal(infinitumGeoEnabled("0"), false);
    if (saved === undefined) delete process.env.INFINITUM_GEO_ENABLED;
    else process.env.INFINITUM_GEO_ENABLED = saved;
  });

  test("policy observation does not change disposition", () => {
    assert.deepEqual(geoPolicy("quarantine", null), { disposition: "quarantine", note: null });
    assert.deepEqual(geoPolicy("deliver", { country: "US", categories: ["mail"] }), {
      disposition: "deliver",
      note: "geo policy observe country=US categories=mail",
    });
  });

  test("missing data files do not throw and do not annotate", async () => {
    const lines: string[] = [];
    const { db } = harness;
    await openMailbox(db, "geo-missing", profile("geo-missing", "missing@cumuluscloud.app", "Ada"));
    const message = letter({ id: "m-missing" });
    const same = await applyGeoHook(
      db,
      "geo-missing",
      message,
      { ip: "1.2.3.4", domain: "example.cn" },
      {
        enabled: true,
        routing: true,
        lists: null,
        log: (line) => lines.push(line),
      },
    );
    assert.equal(same, message);
    assert.deepEqual(lines, ["geo data unavailable"]);
    const again = await applyGeoHook(
      db,
      "geo-missing",
      message,
      { ip: "1.2.3.4" },
      {
        enabled: true,
        routing: true,
        lists: null,
        log: (line) => lines.push(line),
      },
    );
    assert.equal(again, message);
    assert.deepEqual(lines, ["geo data unavailable"]);
  });

  test("off leaves the stored message unchanged, on annotates and keeps the folder", async () => {
    resetGeoHook();
    delete process.env.INFINITUM_GEO_ENABLED;
    delete process.env.INFINITUM_GEO_DIR;
    const { db, storageFor } = harness;
    const ada = profile("geo-ada", "geo.ada@cumuluscloud.app", "Ada");
    await openMailbox(db, "geo-ada", ada);
    const raw = new TextEncoder().encode(RAW);
    const off = await ingestInboundEmail(db, storageFor, {
      from: "mira.chen@cumuluscloud.app",
      to: "geo.ada@cumuluscloud.app",
      raw,
    });
    const offBox = await readSnapshot(db, "geo-ada");
    const offMessage = offBox.messages.find((item) => item.id === off.stored[0]);
    assert.equal(offBox.geoRouting, false);
    assert.equal(offMessage?.geo, undefined);
    assert.equal(offMessage?.folder, "inbox");

    await writeSnapshot(db, storageFor, "geo-ada", { ...offBox, geoRouting: true });
    assert.equal((await readSnapshot(db, "geo-ada")).geoRouting, true);

    const stillOff = await ingestInboundEmail(db, storageFor, {
      from: "mira.chen@cumuluscloud.app",
      to: "geo.ada@cumuluscloud.app",
      raw: new TextEncoder().encode(RAW.replace("Notes", "Notes two")),
    });
    const still = (await readSnapshot(db, "geo-ada")).messages.find(
      (item) => item.id === stillOff.stored[0],
    );
    assert.equal(still?.geo, undefined);

    process.env.INFINITUM_GEO_ENABLED = "1";
    process.env.INFINITUM_GEO_DIR = fixtureDir;
    resetGeoCache();
    const lines: string[] = [];
    const originalLog = console.info;
    console.info = ((line?: unknown) => {
      if (typeof line === "string") lines.push(line);
    }) as typeof console.info;
    try {
      const on = await ingestInboundEmail(
        db,
        storageFor,
        {
          from: "mira.chen@cumuluscloud.app",
          to: "geo.ada@cumuluscloud.app",
          raw: new TextEncoder().encode(RAW.replace("Notes", "Notes three")),
        },
        undefined,
        { INFINITUM_GEO_ENABLED: "1" },
      );
      const stored = (await readSnapshot(db, "geo-ada")).messages.find(
        (item) => item.id === on.stored[0],
      );
      assert.equal(stored?.folder, "inbox");
      assert.equal(stored?.body, "Hello from outside.");
      assert.equal(stored?.geo?.country, "TN");
      assert.deepEqual(stored?.geo?.categories, ["mail"]);
      assert.ok(
        lines.some((line) => line.includes("country=TN") && line.includes("categories=mail")),
      );
      const sealed = await db.query<{ geo_json: string }>(
        `select geo_json from cumulus_mail.messages where tenant_id = $1 and id = $2`,
        ["geo-ada", on.stored[0]],
      );
      const storedGeo = sealed[0]?.geo_json ?? "";
      assert.equal(storedGeo.startsWith("cm1."), true);
      assert.equal(storedGeo.includes("{"), false);
      assert.equal(JSON.parse(openText("geo-ada", storedGeo)).country, "TN");
    } finally {
      console.info = originalLog;
      delete process.env.INFINITUM_GEO_ENABLED;
      delete process.env.INFINITUM_GEO_DIR;
      resetGeoHook();
    }
  });

  test("the fixture directory loads both lists", () => {
    resetGeoCache();
    const lists = loadGeoLists(fixtureDir);
    assert.ok(lists);
    assert.equal(lists?.geoip.entries.length, 5);
    assert.equal(loadGeoLists(fixtureDir), lists);
  });
});
