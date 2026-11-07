import assert from "node:assert/strict";
import { test } from "node:test";
import { PROPOSED_SERVICE_HOSTS, SAMPLE_MAIL_DOMAIN, usesSampleMailDomain } from "./domain.ts";
import { applyRules, archiveThreads, emptyTrash, inBox, isSnoozed, listThreads, markThreadUnread, planDelivery, tomorrowMorning, trashThreads, usesSampleMailDomain as exportedMatch, withSignature } from "./logic.ts";
import { ME, SEED_MESSAGES, type MailMessage } from "./model.ts";

test("the sample mailbox domain is an exact host, not a service name or a lookalike", () => {
  assert.equal(SAMPLE_MAIL_DOMAIN, "cumuluscloud.app");
  assert.equal(ME.email, "alex@cumuluscloud.app");
  assert.equal(usesSampleMailDomain("alex@cumuluscloud.app"), true);
  assert.equal(usesSampleMailDomain("Alex@CumulusCloud.app"), true);
  assert.equal(exportedMatch("leah@cumuluscloud.app"), true);
  assert.equal(usesSampleMailDomain("alex@mail.cumuluscloud.app"), false);
  assert.equal(usesSampleMailDomain(`alex@${PROPOSED_SERVICE_HOSTS.id}`), false);
  assert.equal(usesSampleMailDomain(`alex@${PROPOSED_SERVICE_HOSTS.cloud}`), false);
  assert.equal(usesSampleMailDomain(`alex@${PROPOSED_SERVICE_HOSTS.mail}`), false);
  assert.equal(usesSampleMailDomain("alex@cumuluscloud.app.evil.com"), false);
  assert.equal(usesSampleMailDomain("alex@notcumuluscloud.app"), false);
  assert.equal(usesSampleMailDomain("alex@cumulusmail.cloud"), false);
  assert.deepEqual(PROPOSED_SERVICE_HOSTS, {
    id: "id.cumuluscloud.app",
    cloud: "cloud.cumuluscloud.app",
    mail: "mail.cumuluscloud.app",
  });
});

test("sample-domain recipients stay inside and everyone else is outbound", () => {
  const hops = planDelivery([
    { name: "Leah", email: "leah@cumuluscloud.app" },
    { name: "Priya", email: "priya.shah@vyral.example" },
    { name: "Leah again", email: "Leah@cumuluscloud.app" },
  ]);
  assert.equal(hops.length, 2);
  assert.equal(hops[0]?.status, "inside");
  assert.equal(hops[1]?.status, "outbound");
  assert.match(hops[0]?.detail ?? "", /Not delivered/);
  assert.match(hops[1]?.detail ?? "", /Not sent/);
  assert.equal(/encrypt|delivered inside/i.test(hops.map((hop) => hop.detail).join(" ")), false);
});

test("from: finds a sender and has:file finds an attachment", () => {
  const withFile: MailMessage = {
    ...SEED_MESSAGES[0]!,
    id: "file-1",
    threadId: "file-1",
    attachments: [{ name: "forecast.pdf", size: 1200 }],
  };
  const messages = [withFile, ...SEED_MESSAGES];
  assert.equal(listThreads(messages, "inbox", "from:leah", false).length > 0, true);
  assert.equal(listThreads(messages, "inbox", "from:nobody-zzz", false).length, 0);
  assert.equal(listThreads(messages, "inbox", "has:file", false)[0]?.id, "file-1");
  assert.equal(ME.email, `alex@${SAMPLE_MAIL_DOMAIN}`);
});

test("a search term can match a different message in the same thread", () => {
  const first: MailMessage = {
    ...SEED_MESSAGES[0]!,
    id: "t-1",
    threadId: "th-split",
    from: { name: "Leah Okonkwo", email: "leah@cumuluscloud.app" },
    subject: "Hello",
    body: "See you Thursday.",
    attachments: undefined,
  };
  const reply: MailMessage = {
    ...SEED_MESSAGES[0]!,
    id: "t-2",
    threadId: "th-split",
    from: { name: "Alex Reid", email: ME.email },
    subject: "Re: Hello",
    body: "The budget appendix is attached in Drive.",
    at: "2026-11-05T13:00:00.000Z",
  };
  const rows = listThreads([first, reply, ...SEED_MESSAGES], "inbox", "from:leah budget", false);
  assert.equal(rows.some((row) => row.threadId === "th-split"), true);
});

test("a snoozed note leaves the inbox and an outside send sits in the outbox", () => {
  const message = { ...SEED_MESSAGES[0]!, snoozeUntil: "2099-01-01T00:00:00.000Z" };
  assert.equal(isSnoozed(message, Date.parse("2026-11-05T00:00:00.000Z")), true);
  assert.equal(inBox(message, "inbox", Date.parse("2026-11-05T00:00:00.000Z")), false);
  assert.equal(inBox(message, "snoozed", Date.parse("2026-11-05T00:00:00.000Z")), true);
  assert.equal(inBox(message, "inbox", Date.parse("2099-01-02T00:00:00.000Z")), true);
  const sent = {
    ...SEED_MESSAGES[0]!,
    id: "out-1",
    folder: "sent" as const,
    delivery: [{ email: "a@vyral.example", status: "outbound" as const, detail: "Accepted." }],
  };
  assert.equal(inBox(sent, "outbox"), true);
  assert.equal(tomorrowMorning(new Date("2026-11-05T22:00:00.000Z")), "2026-11-06T08:00:00.000Z");
});

test("archive, unread, and empty trash only touch the conversations you chose", () => {
  const archived = archiveThreads(SEED_MESSAGES, ["th-priya"]);
  assert.equal(archived.find((message) => message.threadId === "th-priya" && message.folder === "inbox"), undefined);
  assert.equal(archived.some((message) => message.threadId === "th-priya" && message.folder === "archive"), true);
  const unread = markThreadUnread(archived, "th-leah");
  assert.equal(unread.some((message) => message.threadId === "th-leah" && message.unread), true);
  const trashed = trashThreads(SEED_MESSAGES, ["th-leah"]);
  assert.equal(emptyTrash(trashed).some((message) => message.folder === "trash"), false);
});

test("rules archive a match and the signature stays above a quote", () => {
  const message = applyRules(SEED_MESSAGES.find((item) => item.from.email.includes("vyral"))!, [
    { id: "r1", from: "vyral", action: "archive" },
  ]);
  assert.equal(message.folder, "archive");
  const signed = withSignature("Hello\n\n—\nOn Monday, Leah wrote:\n> Hi", "Alex Reid");
  assert.equal(signed.startsWith("Hello\n\nAlex Reid\n\n—\n"), true);
});
