import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  createFolder,
  deleteFolder,
  folderLabel,
  folderNameError,
  isCustomFolderId,
  moveThreads,
  reconcileFolders,
  renameFolder,
  sanitizeFolders,
} from "./folders.ts";
import { archiveThreads, inBox, listThreads, unreadInBox } from "./logic.ts";
import { openMailbox, writeSnapshot } from "./mailbox.ts";
import type { CustomFolder, MailMessage } from "./model.ts";
import { readSnapshot } from "./records.ts";
import { defaultSettings, sanitizeSettings } from "./settings.ts";
import { applySieve, parseSieve } from "./sieve.ts";
import { asFolder, type MailboxSnapshot } from "./snapshot.ts";
import { createHarness, profile } from "./test-support.ts";

function msg(id: string, folder: MailMessage["folder"], threadId = id, extra: Partial<MailMessage> = {}): MailMessage {
  return {
    id,
    threadId,
    folder,
    from: { name: "Vyral Billing", email: "billing@vyral.example" },
    to: [{ name: "Ada", email: "ada@cumuluscloud.app" }],
    cc: [],
    subject: `Subject ${id}`,
    body: `Body ${id}`,
    at: "2026-11-01T10:00:00.000Z",
    unread: true,
    starred: false,
    labels: [],
    ...extra,
  };
}

const RECEIPTS: CustomFolder = { id: "folder-receipts1", name: "Receipts" };
const TRAVEL: CustomFolder = { id: "folder-travel1", name: "Travel" };

test("folder ids are a fixed shape and the server accepts them as a folder", () => {
  assert.equal(isCustomFolderId("folder-abc123"), true);
  assert.equal(isCustomFolderId("folder-"), false);
  assert.equal(isCustomFolderId("folder-ABC"), false);
  assert.equal(isCustomFolderId("inbox"), false);
  assert.equal(asFolder("folder-abc123"), "folder-abc123");
  assert.throws(() => asFolder("folder-../x"), /Invalid folder/);
  assert.throws(() => asFolder("receipts"), /Invalid folder/);
});

test("create, rename and delete validate names and keep messages", () => {
  const created = createFolder([], "  Receipts ", "folder-r1");
  assert.deepEqual(created.folders, [{ id: "folder-r1", name: "Receipts" }]);
  assert.throws(() => createFolder(created.folders, "receipts", "folder-r2"), /exists/);
  assert.throws(() => createFolder(created.folders, "Inbox", "folder-r3"), /system folder/);
  assert.throws(() => createFolder(created.folders, "spam", "folder-r4"), /system folder/);
  assert.throws(() => createFolder(created.folders, "   ", "folder-r5"), /Enter a folder name/);
  assert.equal(folderNameError(created.folders, "Travel"), null);

  const both = createFolder(created.folders, "Travel", "folder-t1").folders;
  assert.throws(() => renameFolder(both, "folder-t1", "RECEIPTS"), /exists/);
  const renamed = renameFolder(both, "folder-t1", "Trips");
  assert.equal(renamed[1]?.name, "Trips");
  assert.equal(renameFolder(renamed, "folder-t1", "trips")[1]?.name, "trips");
  assert.throws(() => renameFolder(renamed, "folder-gone", "X"), /no longer exists/);

  const messages = [msg("a", "folder-r1"), msg("b", "folder-r1"), msg("c", "inbox")];
  const removed = deleteFolder(renamed, messages, "folder-r1");
  assert.deepEqual(removed.folders.map((folder) => folder.id), ["folder-t1"]);
  assert.equal(removed.moved, 2);
  assert.deepEqual(removed.messages.map((message) => message.folder), ["inbox", "inbox", "inbox"]);
  assert.equal(removed.messages.length, 3);
});

test("settings keep only well-formed, unique folders", () => {
  const folders = sanitizeFolders([
    RECEIPTS,
    { id: "folder-receipts1", name: "Duplicate id" },
    { id: "folder-other", name: "receipts" },
    { id: "bad id", name: "Bad" },
    { id: "folder-sys", name: "Trash" },
    { id: "folder-quote", name: 'Say "hi"\n' },
    TRAVEL,
  ]);
  assert.deepEqual(folders, [RECEIPTS, { id: "folder-quote", name: "Say hi" }, TRAVEL]);
  assert.deepEqual(defaultSettings().folders, []);
  assert.deepEqual(sanitizeSettings({ folders: [TRAVEL] }).folders, [TRAVEL]);
  assert.deepEqual(sanitizeSettings({}).folders, []);
});

test("moving a thread files received mail; drafts and sent copies stay put", () => {
  const messages = [
    msg("in-1", "inbox", "t1"),
    msg("out-1", "sent", "t1", { unread: false }),
    msg("draft-1", "drafts", "t1"),
    msg("other", "inbox", "t2"),
  ];
  const moved = moveThreads(messages, ["t1"], RECEIPTS.id);
  assert.deepEqual(moved.map((message) => message.folder), [RECEIPTS.id, "sent", "drafts", "inbox"]);
  assert.equal(inBox(moved[0]!, RECEIPTS.id), true);
  assert.equal(inBox(moved[0]!, "inbox"), false);
  assert.equal(listThreads(moved, RECEIPTS.id, "", false).length, 1);
  assert.equal(unreadInBox(moved, RECEIPTS.id), 1);
  assert.equal(moveThreads(moved, ["t1"], RECEIPTS.id), moved);

  const archived = archiveThreads(moved, ["t1"]);
  assert.equal(archived[0]?.folder, "archive");
  assert.equal(archived[1]?.folder, "sent");
});

test("mail in a folder that is gone goes back to the Inbox", () => {
  const messages = [msg("a", RECEIPTS.id), msg("b", TRAVEL.id), msg("c", "archive")];
  const next = reconcileFolders(messages, [TRAVEL]);
  assert.deepEqual(next.map((message) => message.folder), ["inbox", TRAVEL.id, "archive"]);
  assert.equal(reconcileFolders(next, [TRAVEL]), next);
  assert.equal(folderLabel([TRAVEL], TRAVEL.id), "Travel");
  assert.equal(folderLabel([], "archive"), "Archive");
});

test("Sieve fileinto targets a custom folder by name", () => {
  const source = [
    'if header :contains "From" "billing@vyral" {',
    '  fileinto "receipts";',
    "  stop;",
    "}",
    'if header :contains "Subject" "flight" {',
    '  fileinto "folder:Travel";',
    "}",
  ].join("\n");
  const rules = parseSieve(source, [RECEIPTS, TRAVEL]);
  assert.deepEqual(rules[0]?.actions[0], { type: "folder", folder: RECEIPTS.id });
  assert.deepEqual(rules[1]?.actions[0], { type: "folder", folder: TRAVEL.id });

  const filed = applySieve(msg("bill", "inbox"), source, [RECEIPTS, TRAVEL]);
  assert.equal(filed.folder, RECEIPTS.id);
  assert.equal(filed.unread, false);
  const trip = applySieve(
    msg("trip", "inbox", "trip", { from: { name: "Air", email: "air@example.org" }, subject: "Your flight" }),
    source,
    [RECEIPTS, TRAVEL],
  );
  assert.equal(trip.folder, TRAVEL.id);

  // A folder that does not exist makes the script invalid, so nothing is applied.
  assert.throws(() => parseSieve(source, [TRAVEL]), /unknown fileinto receipts/);
  assert.equal(applySieve(msg("bill2", "inbox"), source, [TRAVEL]).folder, "inbox");
  // System folders and labels still work without any folders.
  assert.equal(applySieve(msg("x", "inbox"), 'if header :contains "From" "vyral" {\n  fileinto "archive";\n}').folder, "archive");
});

let harness: Awaited<ReturnType<typeof createHarness>>;

before(async () => {
  harness = await createHarness();
});

after(async () => {
  await harness.close();
});

function snapshot(me: MailboxSnapshot["me"], messages: MailMessage[], folders: CustomFolder[]): MailboxSnapshot {
  return {
    me,
    messages,
    aliases: [],
    briefs: {},
    tasks: [],
    contacts: [],
    signature: "",
    rules: [],
    settings: { ...defaultSettings(), folders },
  };
}

test("folders and filed mail persist; a deleted folder's mail returns to the Inbox on save", async () => {
  const { db, storageFor } = harness;
  const ada = profile("fold-ada", "ada.fold@cumuluscloud.app", "Ada");
  await openMailbox(db, "fold-ada", ada);
  await writeSnapshot(db, storageFor, "fold-ada", snapshot(ada, [msg("f-1", RECEIPTS.id), msg("f-2", TRAVEL.id)], [RECEIPTS, TRAVEL]));
  const saved = await readSnapshot(db, "fold-ada");
  assert.deepEqual(saved.settings?.folders, [RECEIPTS, TRAVEL]);
  assert.equal(saved.messages.find((message) => message.id === "f-1")?.folder, RECEIPTS.id);

  // An older tab still holds f-2 in Travel after Travel was deleted elsewhere.
  await writeSnapshot(db, storageFor, "fold-ada", snapshot(ada, saved.messages, [RECEIPTS]));
  const after = await readSnapshot(db, "fold-ada");
  assert.deepEqual(after.settings?.folders, [RECEIPTS]);
  assert.equal(after.messages.find((message) => message.id === "f-2")?.folder, "inbox");
  assert.equal(after.messages.find((message) => message.id === "f-1")?.folder, RECEIPTS.id);
});

test("internal delivery files mail into the recipient's folder through Sieve", async () => {
  const { db, storageFor } = harness;
  const ada = profile("fold-snd", "snd.fold@cumuluscloud.app", "Ada");
  const bea = profile("fold-rcv", "rcv.fold@cumuluscloud.app", "Bea");
  await openMailbox(db, "fold-snd", ada);
  await openMailbox(db, "fold-rcv", bea);
  const beaSnapshot = snapshot(bea, [], [RECEIPTS]);
  beaSnapshot.settings!.sieve = 'if header :contains "Subject" "invoice" {\n  fileinto "Receipts";\n}';
  await writeSnapshot(db, storageFor, "fold-rcv", beaSnapshot);

  await writeSnapshot(db, storageFor, "fold-snd", snapshot(ada, [
    msg("inv-1", "sent", "inv-1", {
      from: { name: "Ada", email: ada.email },
      to: [{ name: "Bea", email: bea.email }],
      subject: "Invoice 42",
      unread: false,
    }),
  ], []));
  const inbox = await readSnapshot(db, "fold-rcv");
  const copy = inbox.messages.find((message) => message.subject === "Invoice 42");
  assert.equal(copy?.folder, RECEIPTS.id);
});
