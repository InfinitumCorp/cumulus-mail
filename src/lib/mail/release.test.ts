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
