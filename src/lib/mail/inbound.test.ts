import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readAttachment } from "./mailbox.ts";
import { parseMime } from "./mime.ts";
import { ingestInboundEmail } from "./inbound.ts";
import { openMailbox } from "./mailbox.ts";
import { readSnapshot } from "./records.ts";
import { createHarness, profile } from "./test-support.ts";

let harness: Awaited<ReturnType<typeof createHarness>>;

before(async () => {
  harness = await createHarness();
});

after(async () => {
  await harness.close();
});

const RAW = [
  "From: Mira Chen <mira.chen@cumuluscloud.app>",
  "To: Ada <ada.in@cumuluscloud.app>",
  "Subject: =?UTF-8?B?Tm90ZXM=?=",
  "MIME-Version: 1.0",
  "X-Tenant: tenant-bea",
  "Content-Type: multipart/mixed; boundary=abc",
  "",
  "--abc",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Hello from outside.",
  "--abc",
  "Content-Type: text/plain; name=\"note.txt\"",
  "Content-Transfer-Encoding: base64",
  "Content-Disposition: attachment; filename=\"note.txt\"",
  "",
  "aGVsbG8=",
  "--abc--",
  "",
].join("\r\n");

test("MIME parsing keeps the text and the attachment bytes", () => {
  const parsed = parseMime(RAW);
  assert.equal(parsed.subject, "Notes");
  assert.equal(parsed.text, "Hello from outside.");
  assert.equal(parsed.attachments[0]?.name, "note.txt");
  assert.equal(new TextDecoder().decode(parsed.attachments[0]?.bytes), "hello");
  assert.equal(parsed.headers["x-tenant"], "tenant-bea");
});

test("inbound mail is stored for the envelope recipient only", async () => {
  const { db, storageFor } = harness;
  await openMailbox(db, "tenant-ada-in", profile("tenant-ada-in", "ada.in@cumuluscloud.app", "Ada"));
  await openMailbox(db, "tenant-bea-in", profile("tenant-bea-in", "bea.in@cumuluscloud.app", "Bea"));
  const raw = new TextEncoder().encode(RAW);
  const first = await ingestInboundEmail(db, storageFor, {
    from: "mira.chen@cumuluscloud.app",
    to: "ada.in@cumuluscloud.app",
    raw,
  });
  assert.equal(first.stored.length, 1);
  const again = await ingestInboundEmail(db, storageFor, {
    from: "mira.chen@cumuluscloud.app",
    to: "ada.in@cumuluscloud.app",
    raw,
  });
  assert.deepEqual(again.stored, first.stored);

  const ada = await readSnapshot(db, "tenant-ada-in");
  const message = ada.messages.find((item) => item.subject === "Notes");
  assert.ok(message);
  assert.equal(message.body, "Hello from outside.");
  const file = message.attachments?.[0];
  assert.ok(file?.id);
  const stored = await readAttachment(db, storageFor("tenant-ada-in"), "tenant-ada-in", message.id, file.id);
  assert.equal(new TextDecoder().decode(stored?.bytes), "hello");
  const rawRows = await db.query<{ raw_key: string }>(
    `select raw_key from cumulus_mail.messages where tenant_id = $1 and id = $2`,
    ["tenant-ada-in", message.id],
  );
  const rawObject = await storageFor("tenant-ada-in").get(rawRows[0]?.raw_key ?? "");
  assert.equal(rawObject?.body.byteLength, raw.byteLength);
  assert.equal(await storageFor("tenant-bea-in").get(rawRows[0]?.raw_key ?? ""), null);

  const bea = await readSnapshot(db, "tenant-bea-in");
  assert.equal(bea.messages.some((item) => item.subject === "Notes"), false);
  const missing = await ingestInboundEmail(db, storageFor, {
    from: "mira.chen@cumuluscloud.app",
    to: "nobody@cumuluscloud.app",
    raw,
  });
  assert.deepEqual(missing.stored, []);
});
