import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { openMailbox, writeSnapshot } from "../mailbox.ts";
import type { MailMessage } from "../model.ts";
import { readSnapshot } from "../records.ts";
import type { MailboxSnapshot } from "../snapshot.ts";
import { establishedSender, createHarness, profile } from "../test-support.ts";
import { configureOutbound } from "./config.ts";
import { DEFAULT_LIMITS, limitsFromEnv, sendDecision } from "./limits.ts";
import { enqueueOutbound } from "./queue.ts";
import { createMemoryTransport } from "./transport.ts";

let harness: Awaited<ReturnType<typeof createHarness>>;
before(async () => {
  harness = await createHarness();
});
afterEach(() => {
  configureOutbound(undefined);
  delete process.env.MAIL_OUTBOUND_HOURLY_LIMIT;
  delete process.env.MAIL_OUTBOUND_DAILY_LIMIT;
});
after(async () => {
  await harness.close();
});

test("limits come from the environment with safe defaults", () => {
  assert.deepEqual(limitsFromEnv({}), DEFAULT_LIMITS);
  assert.deepEqual(limitsFromEnv({ MAIL_OUTBOUND_HOURLY_LIMIT: "5", MAIL_OUTBOUND_DAILY_LIMIT: "20" }), { hourly: 5, daily: 20 });
  assert.deepEqual(limitsFromEnv({ MAIL_OUTBOUND_HOURLY_LIMIT: "0", MAIL_OUTBOUND_DAILY_LIMIT: "lots" }), DEFAULT_LIMITS);
});

test("over the hourly limit a send is pushed back an hour; over the daily limit it is held", async () => {
  const { db } = harness;
  const ada = profile("lim-d", "d.lim@cumuluscloud.app", "Ada");
  await openMailbox(db, "lim-d", ada);
  await establishedSender(db, "lim-d");
  const limits = { hourly: 2, daily: 4 };
  const now = new Date();
  const queue = async (n: number, at: Date) =>
    enqueueOutbound(db, "lim-d", { messageId: `m-${n}`, from: ada.email, recipient: `r${n}@example.org`, raw: "x" }, at);

  assert.equal((await sendDecision(db, "lim-d", limits, now)).action, "send");
  await queue(1, new Date(now.getTime() - 50 * 60_000));
  await queue(2, new Date(now.getTime() - 10 * 60_000));
  const third = await sendDecision(db, "lim-d", limits, now);
  assert.equal(third.action, "later");
  // The hour frees up when the older of the two is an hour old: 10 minutes from now.
  assert.equal(third.action === "later" ? third.at.getTime() : 0, now.getTime() + 10 * 60_000);
  await queue(3, third.action === "later" ? third.at : now);
  const fourth = await sendDecision(db, "lim-d", limits, now);
  assert.equal(fourth.action, "later");
  assert.equal(fourth.action === "later" ? fourth.at.getTime() : 0, now.getTime() + 50 * 60_000);
  await queue(4, fourth.action === "later" ? fourth.at : now);
  const fifth = await sendDecision(db, "lim-d", limits, now);
  assert.equal(fifth.action, "hold");
  assert.match(fifth.action === "hold" ? fifth.reason : "", /Daily sending limit reached \(4/);
});

function snapshot(me: MailboxSnapshot["me"], messages: MailMessage[]): MailboxSnapshot {
  return { me, messages, aliases: [], briefs: {}, tasks: [], contacts: [], signature: "", rules: [] };
}

test("a save to more outside recipients than allowed sends some now, schedules some, and holds the rest", async () => {
  const { db, storageFor } = harness;
  process.env.MAIL_OUTBOUND_HOURLY_LIMIT = "1";
  process.env.MAIL_OUTBOUND_DAILY_LIMIT = "2";
  const transport = createMemoryTransport();
  configureOutbound({ transport, dkim: null });
  const ada = profile("lim-e", "e.lim@cumuluscloud.app", "Ada");
  await openMailbox(db, "lim-e", ada);
  await establishedSender(db, "lim-e");
  await writeSnapshot(db, storageFor, "lim-e", snapshot(ada, [{
    id: "bulk-1",
    threadId: "bulk-1",
    folder: "sent",
    from: { name: "Ada", email: ada.email },
    to: ["a@example.org", "b@example.org", "c@example.org"].map((email) => ({ name: email, email })),
    cc: [],
    subject: "Hello",
    body: "Hi",
    at: new Date().toISOString(),
    unread: false,
    starred: false,
    labels: [],
  }]));
  assert.deepEqual(transport.sent.map((item) => item.to[0]), ["a@example.org"]);
  const hops = (await readSnapshot(db, "lim-e")).messages.find((item) => item.id === "bulk-1")?.delivery ?? [];
  assert.match(hops.find((hop) => hop.email === "a@example.org")?.detail ?? "", /^Sent by SMTP/);
  assert.match(hops.find((hop) => hop.email === "b@example.org")?.detail ?? "", /Hourly sending limit reached; it goes out after/);
  assert.match(hops.find((hop) => hop.email === "c@example.org")?.detail ?? "", /Daily sending limit reached \(2/);
  const rows = await db.query(`select 1 from cumulus_mail.outbound_queue where tenant_id = $1`, ["lim-e"]);
  assert.equal(rows.length, 2);
});
