import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { openMailbox, writeSnapshot } from "../mailbox.ts";
import type { MailMessage } from "../model.ts";
import { readSnapshot } from "../records.ts";
import type { MailboxSnapshot } from "../snapshot.ts";
import { createHarness, establishedSender, profile } from "../test-support.ts";
import { configureOutbound } from "./config.ts";
import { DEFAULT_LIMITS } from "./limits.ts";
import { BURST_RECIPIENTS, markSendVerified, outboundSafety, PAUSE_MS, spamScore, SPAM_THRESHOLD, warmupLimits } from "./safety.ts";
import { createMemoryTransport } from "./transport.ts";

let harness: Awaited<ReturnType<typeof createHarness>>;
before(async () => {
  harness = await createHarness();
});
after(async () => {
  configureOutbound(undefined);
  await harness.close();
});
afterEach(() => configureOutbound(undefined));

const msg = (subject: string, body: string, to = 1): Pick<MailMessage, "subject" | "body" | "to" | "cc"> => ({
  subject,
  body,
  to: Array.from({ length: to }, (_, i) => ({ name: `R${i}`, email: `r${i}@example.org` })),
  cc: [],
});
const ordinary = msg("Lunch on Friday?", "Hi Bea, are you free for lunch on Friday? The usual place at 1pm. — Ada");
const phishing = msg(
  "URGENT: VERIFY YOUR ACCOUNT NOW!!!",
  "Your account will be closed. Click here to verify your password immediately: https://bit.ly/x1 http://192.0.2.4/login",
);

async function mailbox(tenant: string, options: { verified?: boolean; ageDays?: number } = {}) {
  await openMailbox(harness.db, tenant, profile(tenant, `${tenant}@cumuluscloud.app`));
  if (options.verified) await markSendVerified(harness.db, tenant);
  if (options.ageDays) {
    await harness.db.query(`update cumulus_mail.mailboxes set created_at = now() - make_interval(days => $2) where tenant_id = $1`, [tenant, options.ageDays]);
  }
}

async function queueRows(tenant: string, n: number) {
  for (let i = 0; i < n; i += 1) {
    await harness.db.query(
      `insert into cumulus_mail.outbound_queue (tenant_id, id, message_id, recipient, recipient_bidx, mail_from, raw, status)
       values ($1, $2, $2, 'x', $2, 'x', '', 'sent')`,
      [tenant, `${tenant}-q${i}`],
    );
  }
}

test("warm-up: a new mailbox starts at 10/h and 20/day and reaches the configured caps after a week", () => {
  assert.deepEqual(warmupLimits(DEFAULT_LIMITS, 0), { hourly: 10, daily: 20 });
  assert.deepEqual(warmupLimits(DEFAULT_LIMITS, 2.5), { hourly: 20, daily: 50 });
  assert.deepEqual(warmupLimits(DEFAULT_LIMITS, 6.9), { hourly: 50, daily: 150 });
  assert.deepEqual(warmupLimits(DEFAULT_LIMITS, 7), DEFAULT_LIMITS);
  assert.deepEqual(warmupLimits({ hourly: 5, daily: 10 }, 0), { hourly: 5, daily: 10 }, "never above the configured caps");
});

test("spam score: ordinary mail scores 0; phishing-shaped mail crosses the threshold", () => {
  assert.equal(spamScore(ordinary).score, 0);
  assert.equal(spamScore(msg("Report", "Numbers attached, see https://example.org/q3")).score, 0);
  const bad = spamScore(phishing);
  assert.ok(bad.score >= SPAM_THRESHOLD, `${bad.score}: ${bad.signals.join(", ")}`);
  assert.ok(bad.signals.includes("link shortener") && bad.signals.includes("subject in capitals") && bad.signals.includes("link to a bare IP"));
  assert.ok(spamScore(msg("Hi", "x", 25)).signals.includes("many recipients on one message"));
});

test("an unverified account cannot send outside Cumulus; verifying it lifts that", async () => {
  await mailbox("sf-unver");
  const held = await outboundSafety(harness.db, "sf-unver", ordinary, DEFAULT_LIMITS);
  assert.deepEqual(held, { allowed: false, reason: "Held in the outbox. Verify your Cumulus ID email to send outside Cumulus." });
  await markSendVerified(harness.db, "sf-unver");
  const ok = await outboundSafety(harness.db, "sf-unver", ordinary, DEFAULT_LIMITS);
  assert.deepEqual(ok, { allowed: true, limits: { hourly: 10, daily: 20 } }, "verified, but still in warm-up on day 0");
});

test("a burst of spam-shaped mail pauses outside sending for a day, with the reason; ordinary bursts do not", async () => {
  const now = new Date();
  await mailbox("sf-burst", { verified: true, ageDays: 30 });
  await queueRows("sf-burst", BURST_RECIPIENTS);
  // A burst of ordinary mail (a newsletter to friends, a busy day) is allowed, at full caps.
  assert.deepEqual(await outboundSafety(harness.db, "sf-burst", ordinary, DEFAULT_LIMITS, now), { allowed: true, limits: DEFAULT_LIMITS });
  // The same burst with a spam-shaped message pauses it.
  const paused = await outboundSafety(harness.db, "sf-burst", phishing, DEFAULT_LIMITS, now);
  assert.equal(paused.allowed, false);
  assert.match((paused as { reason: string }).reason, /^Held in the outbox\. Sending outside Cumulus is paused until .+ UTC: many messages in a few minutes, and this one looks like spam \(.+\)\. If this is a mistake, contact support\.$/);
  // While paused, even ordinary mail is held, with the same notice.
  const after = await outboundSafety(harness.db, "sf-burst", ordinary, DEFAULT_LIMITS, new Date(now.getTime() + 60_000));
  assert.equal(after.allowed, false);
  assert.match((after as { reason: string }).reason, /paused until/);
  // After the pause (and once the burst is over), sending resumes.
  await harness.db.query(`delete from cumulus_mail.outbound_queue where tenant_id = 'sf-burst'`);
  const later = await outboundSafety(harness.db, "sf-burst", ordinary, DEFAULT_LIMITS, new Date(now.getTime() + PAUSE_MS + 60_000));
  assert.equal(later.allowed, true);
});

test("in delivery: an unverified mailbox's outside mail is held with the notice, and nothing is queued", async () => {
  const { db, storageFor } = harness;
  const transport = createMemoryTransport();
  configureOutbound({ transport, dkim: null });
  const ada = profile("sf-deliv", "sf.deliv@cumuluscloud.app", "Ada");
  await openMailbox(db, "sf-deliv", ada);
  const snapshot = (messages: MailMessage[]): MailboxSnapshot => ({ me: ada, messages, aliases: [], briefs: {}, tasks: [], contacts: [], signature: "", rules: [] });
  const sent: MailMessage = {
    id: "sfd-1", threadId: "sfd-1", folder: "sent", from: { name: "Ada", email: ada.email }, to: [{ name: "Bea", email: "bea@example.org" }],
    cc: [], subject: "Hello", body: "Hello Bea", at: "2026-11-13T10:00:00.000Z", unread: false, starred: false, labels: [],
  };
  await writeSnapshot(db, storageFor, "sf-deliv", snapshot([sent]));
  const hop = (await readSnapshot(db, "sf-deliv")).messages.find((m) => m.id === "sfd-1")?.delivery?.[0]?.detail;
  assert.equal(hop, "Held in the outbox. Verify your Cumulus ID email to send outside Cumulus.");
  assert.equal(transport.sent.length, 0);
  assert.deepEqual(await db.query(`select 1 from cumulus_mail.outbound_queue where tenant_id = 'sf-deliv'`), []);
  // An established, verified sender's mail goes out.
  await establishedSender(db, "sf-deliv");
  await writeSnapshot(db, storageFor, "sf-deliv", snapshot([{ ...sent, id: "sfd-2", threadId: "sfd-2" }]));
  assert.equal(transport.sent.length, 1);
});
