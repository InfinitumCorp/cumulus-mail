import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { openMailbox, writeSnapshot } from "./mailbox.ts";
import type { MailMessage } from "./model.ts";
import { decodeCursor, encodeCursor, searchMessages, tokenize } from "./search.ts";
import { createHarness, profile } from "./test-support.ts";

let harness: Awaited<ReturnType<typeof createHarness>>;
before(async () => {
  harness = await createHarness();
});
after(async () => {
  await harness.close();
});

const msg = (id: string, at: string, fields: Partial<MailMessage>): MailMessage => ({
  id,
  threadId: id,
  folder: "inbox",
  from: { name: "Someone", email: "someone@example.com" },
  to: [{ name: "Ada", email: "srch.ada@cumuluscloud.app" }],
  cc: [],
  subject: "Hello",
  body: "Nothing here.",
  at,
  unread: false,
  starred: false,
  labels: [],
  ...fields,
});

test("tokenize: words of any script, lower-cased, de-duplicated, 2-40 characters", () => {
  assert.deepEqual(tokenize("Invoice #4411 — Счёт за ноябрь, INVOICE a"), ["invoice", "4411", "счёт", "за", "ноябрь"]);
  assert.deepEqual(tokenize("x".repeat(41) + " ok"), ["ok"]);
  assert.deepEqual(tokenize("one two three", 2), ["one", "two"]);
});

test("cursors are bound to their query and bounded", () => {
  const cursor = encodeCursor(25, ["invoice"]);
  assert.equal(decodeCursor(cursor, ["invoice"]), 25);
  assert.equal(decodeCursor(cursor, ["receipt"]), 0);
  assert.equal(decodeCursor("garbage", ["invoice"]), 0);
  assert.equal(decodeCursor(encodeCursor(999999, ["invoice"]), ["invoice"]), 0);
});

test("ranked, paged, all-words search over the encrypted word index", async () => {
  const db = harness.db;
  const ada = await openMailbox(db, "srch-ada", profile("srch-ada", "srch.ada@cumuluscloud.app", "Ada"));
  const messages = [
    msg("s-subject", "2026-11-01T10:00:00Z", { subject: "November invoice", body: "See attached." }),
    msg("s-body-new", "2026-11-05T10:00:00Z", { subject: "Hi", body: "The invoice for November is late." }),
    msg("s-body-old", "2026-10-01T10:00:00Z", { subject: "Hi", body: "Your November invoice, as promised." }),
    msg("s-sender", "2026-11-02T10:00:00Z", { from: { name: "Invoice Desk", email: "invoice@vendor.example" }, subject: "November", body: "-" }),
    msg("s-trash", "2026-11-06T10:00:00Z", { folder: "trash", subject: "November invoice", body: "-" }),
    msg("s-other", "2026-11-07T10:00:00Z", { subject: "Lunch", body: "Tacos?" }),
    msg("s-ru", "2026-11-08T10:00:00Z", { subject: "Счёт за ноябрь", body: "Оплата до пятницы" }),
  ];
  await writeSnapshot(db, harness.storageFor, "srch-ada", { ...ada, messages: [...ada.messages, ...messages] });

  // Every word must match; subject (4) beats sender (3) beats body (1); ties go to the newest.
  const page = await searchMessages(db, "srch-ada", "invoice November");
  assert.deepEqual(page.hits.map((h) => h.id), ["s-subject", "s-sender", "s-body-new", "s-body-old"]);
  assert.deepEqual(page.hits.map((h) => h.score), [8, 7, 2, 2]);
  assert.equal(page.nextCursor, null);
  assert.equal(page.hits.some((h) => h.id === "s-trash"), false);
  assert.equal(page.hits.some((h) => h.id === "s-other"), false);

  // Trash on request; other scripts; whole words only.
  const withTrash = await searchMessages(db, "srch-ada", "invoice november", { folders: ["trash"] });
  assert.equal(withTrash.hits[0]?.id, "s-trash");
  assert.deepEqual((await searchMessages(db, "srch-ada", "ноябрь")).hits.map((h) => h.id), ["s-ru"]);
  assert.deepEqual((await searchMessages(db, "srch-ada", "invo")).hits, []);
  assert.deepEqual((await searchMessages(db, "srch-ada", "  ")).hits, []);

  // Pages of 2 walk the same order.
  const first = await searchMessages(db, "srch-ada", "invoice november", { limit: 2 });
  assert.deepEqual(first.hits.map((h) => h.id), ["s-subject", "s-sender"]);
  assert.ok(first.nextCursor);
  const second = await searchMessages(db, "srch-ada", "invoice november", { limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.hits.map((h) => h.id), ["s-body-new", "s-body-old"]);
  assert.equal(second.nextCursor, null);

  // No plaintext word is stored: one row per message, arrays of hex HMACs only.
  const rows = await db.query<{ all_words: string[]; subject: string[] }>(
    `select all_words, subject from cumulus_mail.message_words where tenant_id = 'srch-ada'`,
  );
  assert.ok(rows.length >= messages.length);
  const allWords = rows.flatMap((r) => r.all_words);
  assert.ok(allWords.length > 20);
  assert.ok(allWords.every((w) => /^[0-9a-f]{64}$/.test(w)));
  assert.equal(JSON.stringify(rows).includes("invoice"), false);

  // Another tenant's words (same plaintext) neither match nor leak across.
  const bea = await openMailbox(db, "srch-bea", profile("srch-bea", "srch.bea@cumuluscloud.app", "Bea"));
  await writeSnapshot(db, harness.storageFor, "srch-bea", {
    ...bea,
    messages: [...bea.messages, msg("b-invoice", "2026-11-09T10:00:00Z", { subject: "November invoice", to: [] })],
  });
  assert.equal((await searchMessages(db, "srch-ada", "invoice november")).hits.some((h) => h.id === "b-invoice"), false);
  assert.deepEqual((await searchMessages(db, "srch-bea", "invoice november")).hits.map((h) => h.id), ["b-invoice"]);

  // Editing a message re-indexes it.
  const edited = messages.map((m) => (m.id === "s-other" ? { ...m, subject: "Invoice question for November" } : m));
  const fresh = await openMailbox(db, "srch-ada", profile("srch-ada", "srch.ada@cumuluscloud.app", "Ada"));
  await writeSnapshot(db, harness.storageFor, "srch-ada", {
    ...fresh,
    messages: [...fresh.messages.filter((m) => !m.id.startsWith("s-")), ...edited],
  });
  assert.equal((await searchMessages(db, "srch-ada", "invoice november")).hits.some((h) => h.id === "s-other"), true);
  // The old subject word is gone from the index; the unchanged body still matches.
  assert.deepEqual((await searchMessages(db, "srch-ada", "lunch")).hits, []);
  assert.deepEqual((await searchMessages(db, "srch-ada", "tacos")).hits.map((h) => h.id), ["s-other"]);
});

test("reindexing fills in messages that have no word row, and only those", async () => {
  const { reindexMissingWords } = await import("./search.ts");
  const { readMessages } = await import("./records.ts");
  const db = harness.db;
  const box = await openMailbox(db, "srch-old", profile("srch-old", "srch.old@cumuluscloud.app", "Old"));
  await writeSnapshot(db, harness.storageFor, "srch-old", {
    ...box,
    messages: [...box.messages, msg("o-1", "2026-11-01T10:00:00Z", { subject: "Quarterly zeppelin report", to: [] })],
  });
  // Simulate mail stored before migration 0011: drop its word rows.
  await db.query(`delete from cumulus_mail.message_words where tenant_id = 'srch-old'`);
  assert.deepEqual((await searchMessages(db, "srch-old", "zeppelin")).hits, []);

  const counted = await reindexMissingWords(db, readMessages, { tenantId: "srch-old" });
  assert.ok(counted.messages >= 1);
  assert.equal(counted.tenants, 1);
  assert.deepEqual((await searchMessages(db, "srch-old", "zeppelin")).hits, [], "count-only writes nothing");

  const applied = await reindexMissingWords(db, readMessages, { tenantId: "srch-old", apply: true });
  assert.equal(applied.messages, counted.messages);
  assert.deepEqual((await searchMessages(db, "srch-old", "zeppelin")).hits.map((h) => h.id), ["o-1"]);
  assert.deepEqual(await reindexMissingWords(db, readMessages, { tenantId: "srch-old" }), { tenants: 0, messages: 0 });
});
