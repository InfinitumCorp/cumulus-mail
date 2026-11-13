import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { disableFeed, feedIcs, feedStatus, feedTenant, foldIcs, icsText, newFeedToken, rotateFeed } from "./calendar-feed.ts";
import { openMailbox } from "./mailbox.ts";
import type { CalEvent } from "./model.ts";
import { createHarness, profile } from "./test-support.ts";

let harness: Awaited<ReturnType<typeof createHarness>>;
before(async () => {
  harness = await createHarness();
});
after(async () => {
  await harness.close();
});

const event = (over: Partial<CalEvent> = {}): CalEvent => ({
  id: "e1",
  title: "Budget review",
  whenLabel: "Thu 15:00",
  where: "Room 4, Floor 2",
  with: "Leah, Priya",
  sort: "2026-11-19T15:00:00.000Z",
  ...over,
});

test("a feed token opens exactly its own mailbox, and only its hash is stored", async () => {
  const { db } = harness;
  await openMailbox(db, "feed-a", profile("feed-a", "a@cumuluscloud.app"));
  await openMailbox(db, "feed-b", profile("feed-b", "b@cumuluscloud.app"));
  const a = await rotateFeed(db, "feed-a");
  const b = await rotateFeed(db, "feed-b");
  assert.match(a, /^cal_[A-Za-z0-9_-]{43}$/);
  assert.equal(await feedTenant(db, a), "feed-a");
  assert.equal(await feedTenant(db, b), "feed-b");
  const stored = await db.query(`select * from cumulus_mail.calendar_feeds`);
  assert.equal(JSON.stringify(stored).includes(a.slice(4)), false, "the token itself is not in the table");
});

test("rotating stops the old address at once; turning off stops it too", async () => {
  const { db } = harness;
  await openMailbox(db, "feed-rot", profile("feed-rot", "r@cumuluscloud.app"));
  const first = await rotateFeed(db, "feed-rot");
  const second = await rotateFeed(db, "feed-rot");
  assert.equal(await feedTenant(db, first), null, "the old address is dead");
  assert.equal(await feedTenant(db, second), "feed-rot");
  assert.equal((await feedStatus(db, "feed-rot")).enabled, true);
  assert.equal(await disableFeed(db, "feed-rot"), true);
  assert.equal(await feedTenant(db, second), null);
  assert.equal((await feedStatus(db, "feed-rot")).enabled, false);
});

test("junk and guessed tokens open nothing", async () => {
  for (const token of ["", "cal_", "cal_short", "../../etc/passwd", newFeedToken(), `${newFeedToken()}x`]) {
    assert.equal(await feedTenant(harness.db, token), null, token);
  }
});

test("the feed is valid iCalendar: CRLF, escaping, one-hour events, recurrence, no declined events", () => {
  const ics = feedIcs(
    [
      event(),
      event({ id: "e2", title: "Standup; daily, 10 min", rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE", exdates: ["2026-11-24T09:00:00.000Z"], sort: "2026-11-17T09:00:00.000Z" }),
      event({ id: "e3", title: "Declined dinner", rsvp: "declined" }),
      event({ id: "e4", title: "Maybe drinks", rsvp: "tentative", uid: "abc@organizer.example" }),
      event({ id: "e5", title: "No time", sort: "whenever" }),
    ],
    "Alex — Cumulus://Mail",
    new Date("2026-11-13T12:00:00Z"),
  );
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"));
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  assert.equal((ics.match(/BEGIN:VEVENT/g) ?? []).length, 3, "declined and undated events are left out");
  assert.ok(ics.includes("DTSTART:20261119T150000Z\r\nDURATION:PT1H\r\n"));
  assert.ok(ics.includes("SUMMARY:Standup\\; daily\\, 10 min\r\n"));
  assert.ok(ics.includes("LOCATION:Room 4\\, Floor 2\r\n"));
  assert.ok(ics.includes("RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE\r\n"));
  assert.ok(ics.includes("EXDATE:20261124T090000Z\r\n"));
  assert.ok(ics.includes("UID:abc@organizer.example\r\nDTSTAMP:20261113T120000Z\r\n"), "an invite keeps its UID");
  assert.ok(ics.includes("STATUS:TENTATIVE"));
  assert.equal(ics.includes("Declined dinner"), false);
  for (const line of ics.split("\r\n")) assert.ok(new TextEncoder().encode(line).length <= 75, line);
});

test("an RRULE that is not plain RFC 5545 text is dropped, not injected", () => {
  const ics = feedIcs([event({ rrule: "FREQ=DAILY\r\nATTENDEE:mailto:x@evil.example" })], "x");
  assert.equal(ics.includes("ATTENDEE"), false);
  assert.equal(ics.includes("RRULE"), false);
});

test("a title with a line break cannot start a new property", () => {
  const ics = feedIcs([event({ title: "Hi\r\nATTENDEE:mailto:x@evil.example" })], "x");
  assert.equal(/\r\nATTENDEE/.test(ics), false);
  assert.ok(ics.includes("SUMMARY:Hi\\nATTENDEE:mailto:x@evil.example"));
});

test("text escaping and folding", () => {
  assert.equal(icsText("a\\b;c,d\ne"), "a\\\\b\\;c\\,d\\ne");
  const folded = foldIcs(`SUMMARY:${"Ж".repeat(60)}`);
  assert.equal(folded.replace(/\r\n /g, ""), `SUMMARY:${"Ж".repeat(60)}`);
  for (const part of folded.split("\r\n ")) assert.ok(new TextEncoder().encode(part).length <= 75);
});
