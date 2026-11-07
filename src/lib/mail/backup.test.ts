import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ChecksumMismatchError } from "../storage/adapter.ts";
import { exportMailbox, importMailbox } from "./backup.ts";
import { bytesToBase64 } from "./bytes.ts";
import { openMailbox, readAttachment, writeSnapshot } from "./mailbox.ts";
import { readSnapshot } from "./records.ts";
import { createHarness, profile } from "./test-support.ts";
import type { MailMessage } from "./model.ts";

let harness: Awaited<ReturnType<typeof createHarness>>;

before(async () => {
  harness = await createHarness();
});

after(async () => {
  await harness.close();
});

test("export and import round-trip the mailbox and blobs without crossing tenants", async () => {
  const { db, storageFor } = harness;
  const ada = profile("bak-ada", "bak.ada@cumuluscloud.app", "Ada");
  const bea = profile("bak-bea", "bak.bea@cumuluscloud.app", "Bea");
  await openMailbox(db, "bak-ada", ada);
  await openMailbox(db, "bak-bea", bea);
  const payload = new TextEncoder().encode("round trip");
  const message: MailMessage = {
    id: "m-bak-1",
    threadId: "m-bak-1",
    folder: "inbox",
    from: { name: "Bea", email: bea.email },
    to: [{ name: "Ada", email: ada.email }],
    cc: [],
    subject: "Keep this",
    body: "original body",
    at: "2026-11-07T18:00:00.000Z",
    unread: true,
    starred: false,
    labels: ["Personal"],
    attachments: [{ name: "note.txt", size: payload.byteLength, contentType: "text/plain", dataBase64: bytesToBase64(payload) }],
  };
  await writeSnapshot(db, storageFor, "bak-ada", {
    me: ada,
    messages: [message],
    aliases: ["press.bak@cumuluscloud.app"],
    briefs: { th: "short" },
    tasks: [],
    contacts: [],
    signature: "Ada",
    rules: [],
  });
  const backup = await exportMailbox(db, storageFor("bak-ada"), "bak-ada");
  assert.equal(backup.version, 1);
  assert.equal(backup.blobs.length > 0, true);
  const originalBytes = backup.blobs.map((blob) => blob.dataBase64).sort();

  await writeSnapshot(db, storageFor, "bak-ada", {
    me: ada,
    messages: [{ ...message, body: "changed", attachments: [] }],
    aliases: [],
    briefs: {},
    tasks: [],
    contacts: [],
    signature: "",
    rules: [],
  });
  assert.equal((await readSnapshot(db, "bak-ada")).messages[0]?.body, "changed");

  const forged = { ...backup, tenantId: "bak-bea" };
  const restored = await importMailbox(db, storageFor, "bak-ada", forged);
  assert.equal(restored.me.email, ada.email);
  assert.equal(restored.messages[0]?.body, "original body");
  assert.equal(restored.aliases[0], "press.bak@cumuluscloud.app");
  const file = restored.messages[0]?.attachments?.[0];
  assert.ok(file?.id);
  const stored = await readAttachment(db, storageFor("bak-ada"), "bak-ada", "m-bak-1", file.id);
  assert.equal(new TextDecoder().decode(stored?.bytes), "round trip");
  const again = await exportMailbox(db, storageFor("bak-ada"), "bak-ada");
  assert.deepEqual(again.blobs.map((blob) => blob.dataBase64).sort(), originalBytes);

  const beaBefore = (await readSnapshot(db, "bak-bea")).messages.length;
  await importMailbox(db, storageFor, "bak-bea", { ...backup, tenantId: "bak-ada" });
  const beaAfter = await readSnapshot(db, "bak-bea");
  assert.equal(beaAfter.me.email, bea.email);
  assert.equal(beaAfter.messages.some((item) => item.subject === "Keep this"), true);
  assert.equal((await readSnapshot(db, "bak-ada")).me.email, ada.email);
  const beaKeys = await storageFor("bak-bea").list();
  assert.equal(beaKeys.every((item) => item.tenantId === "bak-bea"), true);
  assert.equal(beaBefore >= 0, true);

  const broken = {
    ...backup,
    blobs: backup.blobs.map((blob, index) => (index === 0 ? { ...blob, sha256: "ab".repeat(32) } : blob)),
  };
  await assert.rejects(() => importMailbox(db, storageFor, "bak-ada", broken), ChecksumMismatchError);
});
