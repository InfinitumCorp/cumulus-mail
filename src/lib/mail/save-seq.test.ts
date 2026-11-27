import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { asSaveTag, claimSave } from "./save-seq.ts";
import { openMailbox, writeDelta, writeSnapshot } from "./mailbox.ts";
import { readSnapshot } from "./records.ts";
import { diffSnapshot } from "./delta.ts";
import { createHarness, profile } from "./test-support.ts";
import type { MailMessage } from "./model.ts";

let harness: Awaited<ReturnType<typeof createHarness>>;
before(async () => {
  harness = await createHarness();
});
after(async () => {
  await harness.close();
});

const TAB = "tab-0123456789";
const letter = (id: string): MailMessage => ({
  id,
  threadId: id,
  folder: "inbox",
  from: { name: "Ada", email: "ada@cumuluscloud.app" },
  to: [{ name: "Bea", email: "bea@cumuluscloud.app" }],
  cc: [],
  subject: `Subject ${id}`,
  body: "body",
  at: "2026-11-07T12:00:00.000Z",
  unread: true,
  starred: false,
  labels: [],
});

test("a save tag is optional, and a malformed one is refused", () => {
  assert.equal(asSaveTag(undefined, undefined), undefined);
  assert.deepEqual(asSaveTag(TAB, 3), { tab: TAB, seq: 3 });
  assert.throws(() => asSaveTag("short", 1));
  assert.throws(() => asSaveTag(TAB, -1));
  assert.throws(() => asSaveTag(TAB, 1.5));
  assert.throws(() => asSaveTag("bad tab id!!", 1));
  assert.throws(() => asSaveTag(TAB, undefined));
});

test("each tab's saves are applied only in order; other tabs are independent", async () => {
  const { db } = harness;
  await openMailbox(db, "seq-1", profile("seq-1", "seq1@cumuluscloud.app"));
  assert.equal(await claimSave(db, "seq-1", { tab: TAB, seq: 5 }), true);
  assert.equal(await claimSave(db, "seq-1", { tab: TAB, seq: 4 }), false, "older");
  assert.equal(await claimSave(db, "seq-1", { tab: TAB, seq: 5 }), false, "the same save twice");
  assert.equal(await claimSave(db, "seq-1", { tab: TAB, seq: 6 }), true);
  assert.equal(await claimSave(db, "seq-1", { tab: "tab-other-tab-1", seq: 1 }), true, "another tab");
});

test("the full save still on the wire cannot undo the delta the tab sent as it closed", async () => {
  const { db, storageFor } = harness;
  await openMailbox(db, "seq-2", profile("seq-2", "seq2@cumuluscloud.app"));
  const start = await readSnapshot(db, "seq-2");
  const loaded = await writeSnapshot(db, storageFor, "seq-2", {
    ...start,
    messages: [letter("s-a"), letter("s-b")],
    knownIds: start.messages.map((m) => m.id),
    saveTab: TAB,
    saveSeq: 1,
  });

  // Save 2 (star s-a) is on the wire; then the tab deletes s-b, changes its signature (save 3) and closes.
  const two = { ...loaded, messages: loaded.messages.map((m) => (m.id === "s-a" ? { ...m, starred: true } : m)) };
  const three = { ...two, signature: "after", messages: two.messages.filter((m) => m.id !== "s-b") };
  const delta = diffSnapshot(loaded, three, loaded.revs ?? {})!;
  await writeDelta(db, storageFor, "seq-2", { ...delta, tab: TAB, seq: 3 });

  // Save 2 arrives last. It is not written: s-b stays deleted and the signature stays.
  await writeSnapshot(db, storageFor, "seq-2", {
    ...two,
    knownIds: loaded.messages.map((m) => m.id),
    knownRevs: loaded.revs ?? {},
    saveTab: TAB,
    saveSeq: 2,
  });
  const after = await readSnapshot(db, "seq-2");
  assert.equal(after.messages.some((m) => m.id === "s-b"), false, "the removal stands");
  assert.equal(after.signature, "after", "the field change stands");
  assert.equal(after.messages.find((m) => m.id === "s-a")?.starred, true);

  // An untagged save (an older client) is written as before.
  await writeSnapshot(db, storageFor, "seq-2", { ...after, signature: "untagged", knownIds: after.messages.map((m) => m.id) });
  assert.equal((await readSnapshot(db, "seq-2")).signature, "untagged");
});

test("without migration 0024 saves are written as before", async () => {
  const local = await createHarness();
  try {
    await local.db.query("drop table cumulus_mail.save_sequences");
    await openMailbox(local.db, "seq-3", profile("seq-3", "seq3@cumuluscloud.app"));
    assert.equal(await claimSave(local.db, "seq-3", { tab: TAB, seq: 1 }), true);
    assert.equal(await claimSave(local.db, "seq-3", { tab: TAB, seq: 1 }), true);
  } finally {
    await local.close();
  }
});
