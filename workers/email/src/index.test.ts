import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syntheticGeoFiles } from "../../../src/lib/geo/sample.ts";
import { createHarness, profile } from "../../../src/lib/mail/test-support.ts";
import { openMailbox } from "../../../src/lib/mail/mailbox.ts";
import { readSnapshot } from "../../../src/lib/mail/records.ts";
import handler, { handleEmail } from "./index.ts";

const RAW = new TextEncoder().encode(
  [
    "From: Leah <leah@cumuluscloud.app>",
    "To: Ada <worker.ada@cumuluscloud.app>",
    "Subject: Worker",
    "Content-Type: text/plain",
    "",
    "Stored by the email handler.",
  ].join("\r\n"),
);

test("the email handler refuses to run without an ingest binding", async () => {
  await assert.rejects(
    () => handleEmail({ from: "leah@cumuluscloud.app", to: "ada@cumuluscloud.app", raw: RAW }, {}),
    /not deployed/,
  );
});

test("the email handler parses MIME and stores it through the storage adapter", async () => {
  const harness = await createHarness();
  try {
    await openMailbox(
      harness.db,
      "worker-ada",
      profile("worker-ada", "worker.ada@cumuluscloud.app", "Ada"),
    );
    const result = await handler.email(
      { from: "leah@cumuluscloud.app", to: "worker.ada@cumuluscloud.app", raw: RAW },
      { ingest: { db: harness.db, storageFor: harness.storageFor } },
    );
    assert.equal(result, undefined);
    const box = await readSnapshot(harness.db, "worker-ada");
    const message = box.messages.find((item) => item.subject === "Worker");
    assert.equal(message?.body, "Stored by the email handler.");
    assert.equal(message?.headers?.["x-infinitum-geo-country"], undefined);
    assert.equal(message?.headers?.["x-infinitum-geo-site"], undefined);
    assert.ok(message);
    const rawRows = await harness.db.query<{ raw_key: string }>(
      `select raw_key from cumulus_mail.messages where tenant_id = $1 and id = $2`,
      ["worker-ada", message.id],
    );
    const raw = await harness.storageFor("worker-ada").get(rawRows[0]?.raw_key ?? "");
    assert.equal(raw?.body.byteLength, RAW.byteLength);
  } finally {
    await harness.close();
  }
});

test("the email handler annotates geo only when its env flag is on", async () => {
  const harness = await createHarness();
  const dir = mkdtempSync(join(tmpdir(), "cumulus-worker-geo-"));
  const files = syntheticGeoFiles();
  writeFileSync(join(dir, "geoip.dat"), files.geoip);
  writeFileSync(join(dir, "geosite.dat"), files.geosite);
  const raw = new TextEncoder().encode(
    [
      "From: Leah <leah@cumuluscloud.app>",
      "To: Ada <worker.geo@cumuluscloud.app>",
      "Subject: Geo worker",
      "Content-Type: text/plain",
      "",
      "Annotated by the worker.",
    ].join("\r\n"),
  );
  try {
    await openMailbox(
      harness.db,
      "worker-geo",
      profile("worker-geo", "worker.geo@cumuluscloud.app", "Ada"),
    );
    await handler.email(
      { from: "leah@cumuluscloud.app", to: "worker.geo@cumuluscloud.app", raw },
      {
        ingest: { db: harness.db, storageFor: harness.storageFor },
        INFINITUM_GEO_ENABLED: "1",
        INFINITUM_GEO_DIR: dir,
      },
    );
    const box = await readSnapshot(harness.db, "worker-geo");
    const message = box.messages.find((item) => item.subject === "Geo worker");
    assert.equal(message?.folder, "inbox");
    assert.equal(message?.auth?.disposition, "deliver");
    assert.equal(message?.headers?.["x-infinitum-geo-country"], "US");
    assert.equal(message?.headers?.["x-infinitum-geo-site"], "cumulus");
  } finally {
    await harness.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
