import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { expandEvents, withRsvp } from "./calendar.ts";
import { buildReply, parseInvite, parseReply } from "./invite.ts";
import { openMailbox, writeSnapshot } from "./mailbox.ts";
import { planDelivery } from "./logic.ts";
import type { CalEvent, MailMessage } from "./model.ts";
import { readSnapshot } from "./records.ts";
import { describeRule, occurrences, parseRRule } from "./recurrence.ts";
import { sanitizeSettings } from "./settings.ts";
import type { MailboxSnapshot } from "./snapshot.ts";
import { createHarness, profile } from "./test-support.ts";

const rule = (value: string) => {
  const parsed = parseRRule(value);
  assert.ok(parsed, value);
  return parsed;
};

test("RRULE parsing: supported parts, and unsupported rules rejected", () => {
  assert.deepEqual(parseRRule("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10"), {
    freq: "WEEKLY",
    interval: 2,
    count: 10,
    until: undefined,
    byDay: [{ day: "MO", ordinal: undefined }, { day: "WE", ordinal: undefined }],
  });
  assert.equal(parseRRule("FREQ=MONTHLY;BYDAY=-1FR")?.byDay[0]?.ordinal, -1);
  assert.equal(parseRRule("FREQ=DAILY;UNTIL=20261120")?.until, "2026-11-20T23:59:59.000Z");
  assert.equal(parseRRule("FREQ=DAILY;UNTIL=20261120T100000Z")?.until, "2026-11-20T10:00:00.000Z");
  for (const bad of ["", "FREQ=YEARLY", "FREQ=HOURLY", "FREQ=WEEKLY;BYDAY=XX", "FREQ=MONTHLY;BYDAY=0MO", "FREQ=DAILY;UNTIL=soon"]) {
    assert.equal(parseRRule(bad), null, bad);
  }
  assert.equal(parseRRule("FREQ=DAILY;COUNT=999999")?.count, 500);
});

test("DAILY with COUNT and UNTIL", () => {
  assert.deepEqual(occurrences("2026-11-02T09:00:00.000Z", rule("FREQ=DAILY;COUNT=3")), [
    "2026-11-02T09:00:00.000Z",
    "2026-11-03T09:00:00.000Z",
    "2026-11-04T09:00:00.000Z",
  ]);
  assert.deepEqual(occurrences("2026-11-02T09:00:00.000Z", rule("FREQ=DAILY;INTERVAL=3;UNTIL=20261108")), [
    "2026-11-02T09:00:00.000Z",
    "2026-11-05T09:00:00.000Z",
    "2026-11-08T09:00:00.000Z",
  ]);
});

test("WEEKLY with BYDAY and INTERVAL", () => {
  // Monday 2 Nov 2026.
  assert.deepEqual(occurrences("2026-11-02T15:00:00.000Z", rule("FREQ=WEEKLY;BYDAY=MO,TH;COUNT=4")), [
    "2026-11-02T15:00:00.000Z",
    "2026-11-05T15:00:00.000Z",
    "2026-11-09T15:00:00.000Z",
    "2026-11-12T15:00:00.000Z",
  ]);
  assert.deepEqual(occurrences("2026-11-04T15:00:00.000Z", rule("FREQ=WEEKLY;INTERVAL=2;COUNT=3")), [
    "2026-11-04T15:00:00.000Z",
    "2026-11-18T15:00:00.000Z",
    "2026-12-02T15:00:00.000Z",
  ]);
  // A BYDAY earlier in the start week than the start is not before the start.
  assert.equal(occurrences("2026-11-05T15:00:00.000Z", rule("FREQ=WEEKLY;BYDAY=MO;COUNT=2"))[1], "2026-11-09T15:00:00.000Z");
});

test("MONTHLY by date (skipping short months) and by ordinal weekday", () => {
  assert.deepEqual(occurrences("2026-01-31T10:00:00.000Z", rule("FREQ=MONTHLY;COUNT=3")), [
    "2026-01-31T10:00:00.000Z",
    "2026-03-31T10:00:00.000Z",
    "2026-05-31T10:00:00.000Z",
  ]);
  // Second Tuesday, and last Friday.
  assert.deepEqual(occurrences("2026-11-10T09:00:00.000Z", rule("FREQ=MONTHLY;BYDAY=2TU;COUNT=3")), [
    "2026-11-10T09:00:00.000Z",
    "2026-12-08T09:00:00.000Z",
    "2027-01-12T09:00:00.000Z",
  ]);
  assert.deepEqual(occurrences("2026-11-27T09:00:00.000Z", rule("FREQ=MONTHLY;BYDAY=-1FR;COUNT=2")), [
    "2026-11-27T09:00:00.000Z",
    "2026-12-25T09:00:00.000Z",
  ]);
  assert.equal(occurrences("junk", rule("FREQ=DAILY")).length, 0);
  assert.equal(occurrences("2026-11-02T09:00:00.000Z", rule("FREQ=DAILY")).length, 500);
});

test("rules read as short text", () => {
  assert.equal(describeRule(rule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10")), "Every 2 weeks on Mon, Wed · 10 times");
  assert.equal(describeRule(rule("FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20270101")), "Every month on last Fri · until 2027-01-01");
  assert.equal(describeRule(rule("FREQ=DAILY")), "Every day");
});

const INVITE = [
  "BEGIN:VCALENDAR",
  "METHOD:REQUEST",
  "BEGIN:VEVENT",
  "UID:standup-1@vyral.example",
  "SUMMARY:Standup; daily",
  "DTSTART:20261102T090000Z",
  "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR",
  "ORGANIZER;CN=Leah:mailto:Leah@cumuluscloud.app",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

test("invites carry the rule, UID and organizer; the REPLY round-trips", () => {
  const invite = parseInvite(INVITE);
  assert.ok(invite);
  assert.equal(invite.rrule, "FREQ=WEEKLY;BYDAY=MO,WE,FR");
  assert.equal(invite.uid, "standup-1@vyral.example");
  assert.equal(invite.organizer, "leah@cumuluscloud.app");
  assert.match(invite.whenLabel, /Every week on Mon, Wed, Fri$/);

  const reply = buildReply(invite, { name: 'Alex "A" Reid', email: "alex@cumuluscloud.app" }, "TENTATIVE", new Date("2026-11-12T10:00:00Z"));
  assert.match(reply, /\r\nMETHOD:REPLY\r\n/);
  assert.match(reply, /\r\nDTSTAMP:20261112T100000Z\r\n/);
  assert.match(reply, /\r\nSUMMARY:Standup\\; daily\r\n/);
  assert.match(reply, /\r\nATTENDEE;PARTSTAT=TENTATIVE;CN="Alex A Reid":mailto:alex@cumuluscloud.app\r\n/);
  assert.deepEqual(parseReply(reply), { uid: "standup-1@vyral.example", attendee: "alex@cumuluscloud.app", partstat: "TENTATIVE" });
  // A REPLY is not shown as a new invite.
  assert.equal(parseInvite(reply), null);
  assert.equal(parseReply(INVITE), null);
  assert.throws(() => buildReply({ ...invite, organizer: undefined }, { name: "A", email: "a@b.example" }, "ACCEPTED"), /no organizer/);
});

test("the calendar list expands repeats, hides declines, and keeps one-off events", () => {
  const invite = parseInvite(INVITE)!;
  const oneOff: CalEvent = { id: "e1", title: "Review", whenLabel: "x", where: "", with: "", sort: "2026-11-05T20:00:00.000Z" };
  const rows = expandEvents([oneOff, invite], new Date("2026-11-10T12:00:00Z"), 7);
  assert.deepEqual(rows.map((row) => row.sort), [
    "2026-11-05T20:00:00.000Z",
    "2026-11-11T09:00:00.000Z",
    "2026-11-13T09:00:00.000Z",
    "2026-11-16T09:00:00.000Z",
  ]);
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
  assert.equal(expandEvents([{ ...invite, rsvp: "declined" }], new Date("2026-11-10T12:00:00Z")).length, 0);

  const answered = withRsvp([oneOff], invite, "accepted");
  assert.equal(answered.find((event) => event.id === invite.id)?.rsvp, "accepted");
  assert.equal(withRsvp(answered, invite, "declined").find((event) => event.id === invite.id)?.rsvp, "declined");
  assert.equal(withRsvp(answered, invite, "declined").length, 2);
  // The extra fields survive the server's settings cleanup.
  const kept = sanitizeSettings({ events: answered }).events.find((event) => event.id === invite.id);
  assert.deepEqual([kept?.rrule, kept?.uid, kept?.organizer, kept?.rsvp], [invite.rrule, invite.uid, invite.organizer, "accepted"]);
  assert.equal(sanitizeSettings({ events: [{ ...invite, rsvp: "maybe", organizer: "not-an-email" }] }).events[0]?.rsvp, undefined);
});

let harness: Awaited<ReturnType<typeof createHarness>>;

before(async () => {
  harness = await createHarness();
});

after(async () => {
  await harness.close();
});

function snapshot(me: MailboxSnapshot["me"], messages: MailMessage[]): MailboxSnapshot {
  return { me, messages, aliases: [], briefs: {}, tasks: [], contacts: [], signature: "", rules: [] };
}

test("an RSVP to an internal organizer is delivered through the normal path", async () => {
  const { db, storageFor } = harness;
  const alex = profile("cal-alex", "alex.cal@cumuluscloud.app", "Alex");
  const leah = profile("cal-leah", "leah.cal@cumuluscloud.app", "Leah");
  await openMailbox(db, "cal-alex", alex);
  await openMailbox(db, "cal-leah", leah);
  const invite = parseInvite(INVITE.replace("Leah@cumuluscloud.app", leah.email))!;
  const organizer = { name: leah.email, email: invite.organizer! };
  await writeSnapshot(db, storageFor, "cal-alex", snapshot(alex, [
    {
      id: "rsvp-1",
      threadId: "rsvp-1",
      folder: "sent",
      from: { name: alex.name, email: alex.email },
      to: [organizer],
      cc: [],
      subject: `Accepted: ${invite.title}`,
      body: `Alex accepted.\n\n${buildReply(invite, { name: alex.name, email: alex.email }, "ACCEPTED")}`,
      at: new Date().toISOString(),
      unread: false,
      starred: false,
      labels: [],
      delivery: planDelivery([organizer]),
    },
  ]));
  const received = (await readSnapshot(db, "cal-leah")).messages.find((message) => message.subject.startsWith("Accepted:"));
  assert.ok(received);
  assert.deepEqual(parseReply(received.body), { uid: "standup-1@vyral.example", attendee: alex.email, partstat: "ACCEPTED" });
  assert.equal(parseInvite(received.body), null);
});
