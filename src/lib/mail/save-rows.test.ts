import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { openMailbox, writeDelta, writeSnapshot } from "./mailbox.ts";
import { readSnapshot, sameStoredMessage } from "./records.ts";
import { searchMessages } from "./search.ts";
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

const letter = (id: string, partial: Partial<MailMessage> = {}): MailMessage => ({
  id,
  threadId: id,
  folder: "inbox",
  from: { name: "Ada", email: "ada@example.com" },
  to: [{ name: "Bea", email: "bea@cumuluscloud.app" }],
  cc: [],
  subject: `Subject ${id}`,
  body: `body of ${id} with zebra${id.replace(/\W/g, "")}`,
  at: "2026-11-07T12:00:00.000Z",
  unread: true,
  starred: false,
  labels: [],
  ...partial,
});

type Row = { id: string; body: string; subject: string; folder: string; unread: boolean };
async function rows(tenant: string): Promise<Map<string, Row>> {
  const list = await harness.db.query<Row>(`select id, body, subject, folder, unread from cumulus_mail.messages where tenant_id = $1`, [tenant]);
  return new Map(list.map((row) => [row.id, row]));
}
async function wordRows(tenant: string): Promise<Map<string, string>> {
  const list = await harness.db.query<{ message_id: string; all_words: string[] }>(
    `select message_id, all_words from cumulus_mail.message_words where tenant_id = $1`,
    [tenant],
  );
  return new Map(list.map((row) => [row.message_id, JSON.stringify(row.all_words)]));
}

async function seeded(tenant: string, count = 4) {
  const box = await openMailbox(harness.db, tenant, profile(tenant, `${tenant}@cumuluscloud.app`));
  const messages = Array.from({ length: count }, (_, i) => letter(`m-${i}`));
  return writeSnapshot(harness.db, harness.storageFor, tenant, { ...box, messages, knownIds: [] });
}

const save = (tenant: string, box: Awaited<ReturnType<typeof seeded>>, messages: MailMessage[]) =>
  writeSnapshot(harness.db, harness.storageFor, tenant, {
    ...box,
    messages,
    knownIds: box.messages.map((m) => m.id),
    knownRevs: box.revs ?? {},
  });

test("a save leaves unchanged messages' rows as stored and rewrites only the changed one", async () => {
  const tenant = "rows-1";
  const box = await seeded(tenant);
  const before = await rows(tenant);
  const after = await save(tenant, box, box.messages.map((m) => (m.id === "m-1" ? { ...m, unread: false } : m)));
  const now = await rows(tenant);
  assert.equal(now.size, 4);
  for (const id of ["m-0", "m-2", "m-3"]) {
    assert.equal(now.get(id)!.body, before.get(id)!.body, `${id} keeps its sealed body`);
    assert.equal(now.get(id)!.subject, before.get(id)!.subject);
  }
  // Sealing uses a fresh IV, so a rewritten row's ciphertext always differs.
  assert.notEqual(now.get("m-1")!.body, before.get("m-1")!.body);
  assert.equal(now.get("m-1")!.unread, false);
  assert.equal(after.messages.find((m) => m.id === "m-1")!.unread, false);
  assert.deepEqual(after.messages.map((m) => m.body).sort(), box.messages.map((m) => m.body).sort());
});

test("search still finds unchanged, edited and new messages after a save; a removed one is gone", async () => {
  const tenant = "rows-2";
  const box = await seeded(tenant);
  const words = await wordRows(tenant);
  const next = [
    ...box.messages.filter((m) => m.id !== "m-3").map((m) => (m.id === "m-0" ? { ...m, body: "now about quokka" } : m)),
    letter("m-new", { body: "a fresh wombat" }),
  ];
  await save(tenant, box, next);
  const ids = async (q: string) => (await searchMessages(harness.db, tenant, q)).hits.map((h) => h.id).sort();
  assert.deepEqual(await ids("zebram2"), ["m-2"], "unchanged message still indexed");
  assert.deepEqual(await ids("quokka"), ["m-0"], "edited body re-indexed");
  assert.deepEqual(await ids("zebram0"), [], "old words of the edited body are gone");
  assert.deepEqual(await ids("wombat"), ["m-new"]);
  assert.deepEqual(await ids("zebram3"), [], "removed message is not found");
  const nowWords = await wordRows(tenant);
  assert.equal(nowWords.get("m-1"), words.get("m-1"));
  assert.equal(nowWords.has("m-3"), false);
  const stored = await rows(tenant);
  assert.deepEqual([...stored.keys()].sort(), ["m-0", "m-1", "m-2", "m-new"]);
});

test("every stored field counts: a change to any of them rewrites the row", async () => {
  const base = letter("x", { labels: ["a"], extra: undefined });
  const variants: Array<Partial<MailMessage>> = [
    { folder: "archive" },
    { unread: false },
    { starred: true },
    { labels: ["a", "b"] },
    { subject: "other" },
    { body: "other" },
    { from: { name: "Zed", email: "ada@example.com" } },
    { from: { name: "Ada", email: "zed@example.com" } },
    { to: [] },
    { cc: [{ name: "C", email: "c@example.com" }] },
    { at: "2026-11-08T12:00:00.000Z" },
    { snoozeUntil: "2026-11-09T00:00:00.000Z" },
    { threadId: "y" },
    { headers: { "x-a": "1" } },
    { delivery: { status: "sent", at: "2026-11-07T12:00:00.000Z" } as MailMessage["delivery"] },
  ];
  assert.equal(sameStoredMessage(base, { ...base }), true);
  for (const change of variants) assert.equal(sameStoredMessage({ ...base, ...change }, base), false, JSON.stringify(change));
  assert.equal(sameStoredMessage({ ...base, id: "other" }, base), false);
});

test("an unchanged message another request removed during the save is written back, as a full replace did", async () => {
  const tenant = "rows-3";
  const box = await seeded(tenant, 3);
  const realQuery = harness.db.query;
  let removed = false;
  harness.db.query = (async (text: string, params?: unknown[]) => {
    // Just as the save's transaction starts, another request deletes m-2.
    if (!removed && /^\s*BEGIN/i.test(text)) {
      removed = true;
      await realQuery(`delete from cumulus_mail.messages where tenant_id = $1 and id = 'm-2'`, [tenant]);
    }
    return realQuery(text, params);
  }) as typeof harness.db.query;
  try {
    await save(tenant, box, box.messages.map((m) => (m.id === "m-0" ? { ...m, starred: true } : m)));
  } finally {
    harness.db.query = realQuery;
  }
  assert.equal(removed, true);
  const after = await readSnapshot(harness.db, tenant);
  assert.deepEqual(after.messages.map((m) => m.id).sort(), ["m-0", "m-1", "m-2"]);
  assert.deepEqual((await searchMessages(harness.db, tenant, "zebram2")).hits.map((h) => h.id), ["m-2"]);
});

test("a delta save applies on the mailbox read once and returns the stored result", async () => {
  const tenant = "rows-4";
  const box = await seeded(tenant, 3);
  const before = await rows(tenant);
  const changed = { ...box, messages: box.messages.map((m) => (m.id === "m-2" ? { ...m, starred: true } : m)) };
  const delta = diffSnapshot(box, changed, box.revs ?? {});
  assert.ok(delta);
  const after = await writeDelta(harness.db, harness.storageFor, tenant, delta);
  assert.equal(after.messages.find((m) => m.id === "m-2")!.starred, true);
  assert.equal((after.revs ?? {})["m-2"], 1, "the delta still counts as a server-side change");
  const now = await rows(tenant);
  assert.equal(now.get("m-0")!.body, before.get("m-0")!.body);
  assert.notEqual(now.get("m-2")!.body, before.get("m-2")!.body);
});
