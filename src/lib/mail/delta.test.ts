import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { TenantAccessError } from "../storage/adapter.ts";
import { applyDelta, diffSnapshot, DELTA_MAX_BYTES } from "./delta.ts";
import { asDelta } from "./delta-check.ts";
import { openMailbox, writeDelta, writeSnapshot } from "./mailbox.ts";
import { readSnapshot } from "./records.ts";
import { createHarness, profile } from "./test-support.ts";
import type { MailMessage } from "./model.ts";
import type { MailboxSnapshot } from "./snapshot.ts";

let harness: Awaited<ReturnType<typeof createHarness>>;
before(async () => {
  harness = await createHarness();
});
after(async () => {
  await harness.close();
});

function letter(id: string, partial: Partial<MailMessage> = {}): MailMessage {
  return {
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
    ...partial,
  };
}

const snap = (messages: MailMessage[], extra: Partial<MailboxSnapshot> = {}): MailboxSnapshot => ({
  me: profile("t", "t@cumuluscloud.app"),
  messages,
  aliases: [],
  briefs: {},
  tasks: [],
  contacts: [],
  signature: "",
  rules: [],
  ...extra,
});

test("a delta carries only what changed since the acknowledged snapshot", () => {
  const saved = snap([letter("a"), letter("b"), letter("c")]);
  const current = snap([letter("a"), { ...letter("b"), folder: "trash" }, letter("d")], { signature: "new" });
  const delta = diffSnapshot(saved, current, { b: 3, c: 1 });
  assert.ok(delta);
  assert.deepEqual(delta.upsert.map((message) => message.id), ["b", "d"]);
  assert.deepEqual(delta.remove, ["c"]);
  assert.deepEqual(delta.fields, { signature: "new" });
  assert.deepEqual(delta.base, { b: 3, c: 1 }, "changed and removed messages the tab knew carry their rev; a new one does not");
  const fromZero = diffSnapshot(saved, snap([{ ...letter("a"), unread: false }, letter("b"), letter("c")]), {});
  assert.deepEqual(fromZero?.base, { a: 0 }, "a message at rev 0 when the tab loaded says so");
  assert.equal(diffSnapshot(saved, saved, {}), null, "nothing changed, nothing to send");
});

test("a delta is not made when it cannot go as a small save", () => {
  const saved = snap([letter("a")]);
  const withFile = snap([letter("a", { attachments: [{ name: "x.txt", size: 3, dataBase64: "eHl6" }] })]);
  assert.equal(diffSnapshot(saved, withFile, {}), null, "new file bytes go with the full save");
  const big = snap([letter("a", { body: "x".repeat(DELTA_MAX_BYTES) })]);
  assert.equal(diffSnapshot(saved, big, {}), null, "over the keepalive limit");
});

test("applying a delta keeps what it does not mention and marks every server message as known", () => {
  const current = { ...snap([letter("a"), letter("b"), letter("c")]), revs: { a: 2 } };
  const next = applyDelta(current, { base: { b: 0 }, upsert: [{ ...letter("b"), starred: true }, letter("d")], remove: ["c"] });
  assert.deepEqual(next.messages.map((message) => [message.id, message.starred]), [["a", false], ["b", true], ["d", false]]);
  assert.deepEqual(next.knownIds, ["a", "b", "c"]);
  assert.deepEqual(next.knownRevs, { a: 2, b: 0 });
  assert.equal("revs" in next, false);
});

test("the server refuses a malformed delta, a caller tenant, file bytes and fields it does not take", () => {
  const ok = { base: {}, upsert: [], remove: [] };
  assert.deepEqual(asDelta(ok), ok);
  assert.throws(() => asDelta({ ...ok, tenantId: "other" }), TenantAccessError);
  assert.throws(() => asDelta({ ...ok, upsert: "x" }));
  assert.throws(() => asDelta({ ...ok, remove: [1] }));
  assert.throws(() => asDelta({ ...ok, base: { a: -1 } }));
  assert.throws(() => asDelta({ ...ok, upsert: [letter("a", { attachments: [{ name: "x", size: 1, dataBase64: "eA" }] })] }), /full save/);
  assert.throws(() => asDelta({ ...ok, fields: { me: { email: "boss@cumuluscloud.app" } } }));
  assert.throws(() => asDelta({ ...ok, fields: { messages: [] } }));
});

test("a delta written on the server gives the same mailbox as the full save, and a stale copy loses", async () => {
  const { db, storageFor } = harness;
  const me = profile("delta-1", "delta1@cumuluscloud.app", "Delta");
  await openMailbox(db, "delta-1", me);
  const start = await readSnapshot(db, "delta-1");
  const saved = await writeSnapshot(db, storageFor, "delta-1", {
    ...start,
    messages: [letter("d-a"), letter("d-b"), letter("d-c")],
    knownIds: start.messages.map((message) => message.id),
  });

  // The tab trashes d-a, stars d-b, removes d-c and changes its signature; only the delta reaches the server.
  const current = {
    ...saved,
    signature: "Sent from the delta",
    messages: saved.messages
      .filter((message) => message.id !== "d-c")
      .map((message) => (message.id === "d-a" ? { ...message, folder: "trash" as const } : message.id === "d-b" ? { ...message, starred: true } : message)),
  };
  const delta = diffSnapshot(saved, current, saved.revs ?? {});
  assert.ok(delta);
  await writeDelta(db, storageFor, "delta-1", asDelta(JSON.parse(JSON.stringify(delta))));
  const after = await readSnapshot(db, "delta-1");
  const byId = new Map(after.messages.map((message) => [message.id, message]));
  assert.equal(byId.get("d-a")?.folder, "trash");
  assert.equal(byId.get("d-b")?.starred, true);
  assert.equal(byId.has("d-c"), false);
  assert.equal(after.signature, "Sent from the delta");
  assert.equal(after.me.email, "delta1@cumuluscloud.app");

  // Mail that arrived after the tab loaded is not in its snapshot and is kept.
  await writeSnapshot(db, storageFor, "delta-1", { ...after, messages: [...after.messages, letter("d-new")], knownIds: after.messages.map((m) => m.id) });
  await writeDelta(db, storageFor, "delta-1", { base: {}, upsert: [], remove: [], fields: { signature: "again" } });
  assert.equal((await readSnapshot(db, "delta-1")).messages.some((message) => message.id === "d-new"), true);

  let lastSnap: MailboxSnapshot | null = null;
  const last0 = () => lastSnap!;
  // The full save the delta stood in for, still on the wire with an older copy, lands after it and loses.
  const before = await readSnapshot(db, "delta-1");
  await writeSnapshot(db, storageFor, "delta-1", {
    ...saved,
    messages: saved.messages.map((message) => (message.id === "d-a" ? { ...message, folder: "inbox" as const } : message)),
    knownIds: saved.messages.map((message) => message.id),
    knownRevs: saved.revs ?? {},
  });
  const raced = await readSnapshot(db, "delta-1");
  assert.equal(raced.messages.find((message) => message.id === "d-a")?.folder, "trash", "the older full save did not undo the delta");
  assert.ok((before.revs ?? {})["d-a"]! > 0);
  lastSnap = await readSnapshot(db, "delta-1");

  // The server changes a message after the tab loaded it at rev 0 (a delivery report, a released send);
  // the tab's delta, built from its older copy, neither overwrites nor deletes it.
  await writeSnapshot(db, storageFor, "delta-1", { ...last0(), messages: [...last0().messages, letter("d-r0")], knownIds: last0().messages.map((m) => m.id) });
  const loaded = await readSnapshot(db, "delta-1");
  await db.query(`update cumulus_mail.messages set server_rev = server_rev + 1, subject = 'server copy' where tenant_id = $1 and id = $2`, ["delta-1", "d-r0"]);
  const tabCopy = loaded.messages.find((m) => m.id === "d-r0")!;
  const upsertStale = diffSnapshot(loaded, { ...loaded, messages: loaded.messages.map((m) => (m.id === "d-r0" ? { ...tabCopy, unread: false } : m)) }, loaded.revs ?? {});
  assert.deepEqual(upsertStale?.base, { "d-r0": 0 });
  await writeDelta(db, storageFor, "delta-1", upsertStale!);
  assert.equal((await readSnapshot(db, "delta-1")).messages.find((m) => m.id === "d-r0")?.subject, "server copy");
  const removeStale = diffSnapshot(loaded, { ...loaded, messages: loaded.messages.filter((m) => m.id !== "d-r0") }, loaded.revs ?? {});
  await writeDelta(db, storageFor, "delta-1", removeStale!);
  assert.equal((await readSnapshot(db, "delta-1")).messages.some((m) => m.id === "d-r0"), true, "not deleted from a stale copy");

  // A message the server changed since the tab's base keeps the server's copy.
  await db.query(`update cumulus_mail.messages set server_rev = 5 where tenant_id = $1 and id = $2`, ["delta-1", "d-b"]);
  await writeDelta(db, storageFor, "delta-1", { base: { "d-b": 0 }, upsert: [{ ...letter("d-b"), starred: false, subject: "stale" }], remove: [] });
  const last = await readSnapshot(db, "delta-1");
  assert.equal(last.messages.find((message) => message.id === "d-b")?.subject, "Subject d-b");
});
