import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { openMailbox, writeSnapshot } from "./mailbox.ts";
import type { MailMessage } from "./model.ts";
import { insertMessage, readSnapshot } from "./records.ts";
import { releaseScheduledMail } from "./release.ts";
import type { MailboxSnapshot } from "./snapshot.ts";
import { createHarness, profile } from "./test-support.ts";

let harness: Awaited<ReturnType<typeof createHarness>>;

before(async () => {
  harness = await createHarness();
});

after(async () => {
  await harness.close();
});

function draft(id: string, to: string, scheduleAt: string, subject = id): MailMessage {
  return {
    id,
    threadId: `t-${id}`,
    folder: "drafts",
    from: { name: "Ada", email: "ada.rel@cumuluscloud.app" },
    to: [{ name: "Bea", email: to }],
    cc: [],
    subject,
    body: `Body of ${id}`,
    at: "2026-01-01T00:00:00.000Z",
    unread: false,
    starred: false,
    labels: [],
    extra: { scheduleAt },
  };
}

function snapshot(me: MailboxSnapshot["me"], messages: MailMessage[]): MailboxSnapshot {
  return { me, messages, aliases: [], briefs: {}, tasks: [], contacts: [], signature: "", rules: [] };
}

test("a due scheduled draft is sent and delivered with no tab open; a future one waits", async () => {
  const { db, storageFor } = harness;
  const ada = profile("rel-ada", "ada.rel@cumuluscloud.app", "Ada");
  const bea = profile("rel-bea", "bea.rel@cumuluscloud.app", "Bea");
  await openMailbox(db, "rel-ada", ada);
  await openMailbox(db, "rel-bea", bea);
  const later = new Date(Date.now() + 60 * 60_000).toISOString();
  const soon = new Date(Date.now() + 60_000).toISOString();
  // Saved by the app while both were still in the future.
  await writeSnapshot(db, storageFor, "rel-ada", snapshot(ada, [
    draft("rel-due", bea.email, soon, "Due now"),
    draft("rel-later", bea.email, later, "Not yet"),
  ]));
  assert.equal((await readSnapshot(db, "rel-bea")).messages.some((m) => m.subject === "Due now"), false);

  // The cron runs two minutes later. Delivery checks the real clock, so move
  // the first draft's time into the past the way the clock would.
  await insertMessage(db, "rel-ada", draft("rel-due", bea.email, "2000-01-01T00:00:00.000Z", "Due now"), null);
  const report = await releaseScheduledMail(db, storageFor, Date.now() + 2 * 60_000);
  assert.equal(report.released, 1);
  assert.equal(report.failed, 0);

  const box = await readSnapshot(db, "rel-ada");
  const sent = box.messages.find((m) => m.id === "rel-due");
  assert.equal(sent?.folder, "sent");
  assert.equal(sent?.extra?.scheduleAt, undefined);
  assert.equal(sent?.from.email, ada.email);
  assert.equal(box.messages.find((m) => m.id === "rel-later")?.folder, "drafts");
  assert.equal(box.messages.find((m) => m.id === "rel-later")?.extra?.scheduleAt, later);

  const inbox = await readSnapshot(db, "rel-bea");
  assert.equal(inbox.messages.filter((m) => m.subject === "Due now" && m.folder === "inbox").length, 1);
  assert.equal(inbox.messages.some((m) => m.subject === "Not yet"), false);

  // A second run does not send it again.
  const again = await releaseScheduledMail(db, storageFor, Date.now() + 2 * 60_000);
  assert.equal(again.released, 0);
  const inboxAgain = await readSnapshot(db, "rel-bea");
  assert.equal(inboxAgain.messages.filter((m) => m.subject === "Due now").length, 1);
});

test("an edit saved after the cron read wins over the release", async () => {
  const { db, storageFor } = harness;
  const cy = profile("rel-cy", "cy.rel@cumuluscloud.app", "Cy");
  await openMailbox(db, "rel-cy", cy);
  await insertMessage(db, "rel-cy", draft("rel-race", "someone@cumuluscloud.app", "2000-01-01T00:00:00.000Z"), null);

  // Wrap the db so the app's edit lands between the cron's read and its update.
  let edited = false;
  const racing = {
    query: async <T>(text: string, params?: unknown[]): Promise<T[]> => {
      if (!edited && /^\s*update cumulus_mail\.messages/i.test(text)) {
        edited = true;
        const rescheduled = draft("rel-race", "someone@cumuluscloud.app", "2099-01-01T00:00:00.000Z");
        await insertMessage(db, "rel-cy", rescheduled, null);
      }
      return db.query<T>(text, params);
    },
  };
  const report = await releaseScheduledMail(racing, storageFor);
  assert.equal(edited, true);
  assert.equal(report.released, 0);
  const message = (await readSnapshot(db, "rel-cy")).messages.find((m) => m.id === "rel-race");
  assert.equal(message?.folder, "drafts");
  assert.equal(message?.extra?.scheduleAt, "2099-01-01T00:00:00.000Z");
});

test("the scan finds drafts by the coarse due hour: future and unscheduled drafts are not touched", async () => {
  const { db, storageFor } = harness;
  const { dueHour } = await import("./records.ts");
  assert.equal(dueHour({ folder: "drafts", extra: { scheduleAt: "2026-11-12T10:42:07.000Z" } }), "2026-11-12T10:00:00.000Z");
  assert.equal(dueHour({ folder: "drafts", extra: { pgp: true } }), "infinity");
  assert.equal(dueHour({ folder: "inbox", extra: { scheduleAt: "2026-11-12T10:42:07.000Z" } }), null);

  const dee = profile("rel-due", "dee.rel@cumuluscloud.app", "Dee");
  await openMailbox(db, "rel-due", dee);
  const later = new Date(Date.now() + 5 * 3_600_000).toISOString();
  await insertMessage(db, "rel-due", draft("due-later", "x@cumuluscloud.app", later), null);
  await insertMessage(db, "rel-due", { ...draft("due-none", "x@cumuluscloud.app", later), extra: { pgp: true } }, null);
  const stored = await db.query<{ id: string; due_at: string | Date | null }>(
    `select id, due_at from cumulus_mail.messages where tenant_id = $1 order by id`,
    ["rel-due"],
  );
  // Drivers return 'infinity' differently (PGLite: an invalid Date; pg: the string or Infinity).
  const asText = (value: string | Date | null) =>
    value === null ? null : value instanceof Date ? (Number.isNaN(value.getTime()) ? "infinity" : value.toISOString()) : String(value);
  const due = Object.fromEntries(stored.map((row) => [row.id, asText(row.due_at)]));
  assert.equal(due["due-none"], "infinity");
  assert.equal(new Date(due["due-later"]!).getMinutes(), 0);
  // Nothing in this mailbox is due, so the job does not even list it.
  const quiet = await releaseScheduledMail(db, storageFor, Date.now());
  assert.equal(quiet.released, 0);
  const listed = await db.query(
    `select 1 from cumulus_mail.messages where tenant_id = $1 and folder = 'drafts' and due_at <= $2`,
    ["rel-due", new Date().toISOString()],
  );
  assert.equal(listed.length, 0);

  // Inside the due hour it is found and released at the exact time, not before.
  const exact = Date.parse(later);
  const folderOf = async () =>
    (await db.query<{ folder: string }>(`select folder from cumulus_mail.messages where tenant_id = $1 and id = 'due-later'`, ["rel-due"]))[0]?.folder;
  await releaseScheduledMail(db, storageFor, exact - 60_000);
  assert.equal(await folderOf(), "drafts");
  await releaseScheduledMail(db, storageFor, exact + 60_000);
  assert.equal(await folderOf(), "sent");
  const after = await db.query<{ folder: string; due_at: unknown }>(
    `select folder, due_at from cumulus_mail.messages where tenant_id = $1 and id = 'due-later'`,
    ["rel-due"],
  );
  assert.equal(after[0]?.folder, "sent");
  assert.equal(after[0]?.due_at, null);
});

test("drafts saved before the due column existed are backfilled once", async () => {
  const { db, storageFor } = harness;
  const old = profile("rel-old", "old.rel@cumuluscloud.app", "Old");
  await openMailbox(db, "rel-old", old);
  const later = new Date(Date.now() + 3 * 3_600_000).toISOString();
  await insertMessage(db, "rel-old", draft("old-1", "x@cumuluscloud.app", later), null);
  await db.query(`update cumulus_mail.messages set due_at = null where tenant_id = $1`, ["rel-old"]);
  await releaseScheduledMail(db, storageFor, Date.now());
  const rows = await db.query<{ due_at: unknown }>(`select due_at from cumulus_mail.messages where tenant_id = $1 and id = 'old-1'`, ["rel-old"]);
  assert.notEqual(rows[0]?.due_at, null);
});
