/**
 * A mailbox backup is a file the person uploads: it can say anything. Importing one is checked like a
 * save (mailbox.ts writeSnapshot). Before, an import could send mail as someone else (a "sent" message
 * with another person's From, delivered on import) and take another mailbox's address as an alias.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { exportMailbox, importMailbox } from "./backup.ts";
import { openMailbox, writeSnapshot } from "./mailbox.ts";
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

const mail = (id: string, folder: MailMessage["folder"], from: string, to: string, subject: string): MailMessage => ({
  id,
  threadId: id,
  folder,
  from: { name: from.split("@")[0]!, email: from },
  to: [{ name: to.split("@")[0]!, email: to }],
  cc: [],
  subject,
  body: "text",
  at: new Date().toISOString(),
  unread: false,
  starred: false,
  labels: [],
});

async function backupOf(tenant: string, overrides: Record<string, unknown>) {
  const snapshot = await readSnapshot(harness.db, tenant);
  return {
    version: 1,
    me: snapshot.me,
    messages: [],
    aliases: [],
    briefs: {},
    tasks: [],
    contacts: [],
    signature: "",
    rules: [],
    settings: snapshot.settings,
    blobs: [],
    attachments: [],
    rawKeys: [],
    suppressions: [],
    deliveredIds: [],
    ...overrides,
  } as never;
}

test("an imported backup cannot send as someone else, and sends nothing at all", async () => {
  const { db, storageFor } = harness;
  await openMailbox(db, "imp-alice", profile("imp-alice", "imp.alice@cumuluscloud.app", "Alice"));
  await openMailbox(db, "imp-bob", profile("imp-bob", "imp.bob@cumuluscloud.app", "Bob"));
  await openMailbox(db, "imp-carol", profile("imp-carol", "imp.carol@cumuluscloud.app", "Carol"));
  const forged = mail("forged-1", "sent", "imp.alice@cumuluscloud.app", "imp.carol@cumuluscloud.app", "Wire the money");
  const restored = await importMailbox(db, storageFor, "imp-bob", await backupOf("imp-bob", { messages: [forged] }));
  // Bob's copy shows Bob as the sender, and nothing reached Carol.
  assert.deepEqual(restored.messages.find((m) => m.id === "forged-1")?.from, { name: "Bob", email: "imp.bob@cumuluscloud.app" });
  const carol = await readSnapshot(db, "imp-carol");
  assert.equal(carol.messages.some((m) => m.subject === "Wire the money"), false, "an import never delivers");
});

test("an imported backup cannot take another mailbox's address, and keeps to the plan's limits", async () => {
  const { db, storageFor } = harness;
  await openMailbox(db, "imp-dan", profile("imp-dan", "imp.dan@cumuluscloud.app", "Dan"));
  await openMailbox(db, "imp-eve", profile("imp-eve", "imp.eve@cumuluscloud.app", "Eve"));
  // Another mailbox's address is left out; the rest of the backup (here, a free alias) is restored.
  const restored = await importMailbox(
    db,
    storageFor,
    "imp-eve",
    await backupOf("imp-eve", { aliases: ["imp.dan@cumuluscloud.app", "eve.extra@cumuluscloud.app"] }),
  );
  assert.deepEqual(restored.aliases, ["eve.extra@cumuluscloud.app"]);
  const limit = (await readSnapshot(db, "imp-eve")).me.limits!.messages;
  const tooMany = Array.from({ length: limit + 1 }, (_, i) => mail(`m-${i}`, "inbox", "x@example.com", "imp.eve@cumuluscloud.app", "hi"));
  await assert.rejects(importMailbox(db, storageFor, "imp-eve", await backupOf("imp-eve", { messages: tooMany })), /too large/);
});

test("restoring one's own export still works: mail, aliases and sent copies come back, nothing is re-sent", async () => {
  const { db, storageFor } = harness;
  await openMailbox(db, "imp-fay", profile("imp-fay", "imp.fay@cumuluscloud.app", "Fay"));
  await openMailbox(db, "imp-gus", profile("imp-gus", "imp.gus@cumuluscloud.app", "Gus"));
  const base = await readSnapshot(db, "imp-fay");
  await writeSnapshot(db, storageFor, "imp-fay", {
    ...base,
    aliases: ["fay.work@cumuluscloud.app"],
    messages: [...base.messages, mail("fay-out", "sent", "imp.fay@cumuluscloud.app", "imp.gus@cumuluscloud.app", "Hello Gus")],
  });
  const gusBefore = (await readSnapshot(db, "imp-gus")).messages.filter((m) => m.subject === "Hello Gus").length;
  assert.equal(gusBefore, 1, "delivered once by the save");
  const backup = await exportMailbox(db, storageFor("imp-fay"), "imp-fay");
  const restored = await importMailbox(db, storageFor, "imp-fay", backup);
  assert.deepEqual(restored.aliases, ["fay.work@cumuluscloud.app"]);
  assert.ok(restored.messages.some((m) => m.id === "fay-out"));
  assert.equal((await readSnapshot(db, "imp-gus")).messages.filter((m) => m.subject === "Hello Gus").length, 1, "not delivered again");
});
