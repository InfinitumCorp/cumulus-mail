// The RRULE parts added for real-world invitations (BYMONTH, BYMONTHDAY, BYDAY in YEARLY) and RDATE.
import assert from "node:assert/strict";
import { test } from "node:test";
import { expandEvents } from "./calendar.ts";
import { feedIcs } from "./calendar-feed.ts";
import { parseInvite } from "./invite.ts";
import type { CalEvent } from "./model.ts";
import { describeRule, occurrences, parseRRule } from "./recurrence.ts";
import { defaultSettings, sanitizeSettings } from "./settings.ts";

const rule = (value: string) => {
  const parsed = parseRRule(value);
  assert.ok(parsed, value);
  return parsed;
};
const days = (start: string, value: string, limit?: number) => occurrences(start, rule(value), { limit }).map((iso) => iso.slice(0, 10));

test("YEARLY + BYMONTH + BYDAY: US Thanksgiving, Mother's Day, the last Sunday of March", () => {
  assert.deepEqual(days("2026-11-26T17:00:00Z", "FREQ=YEARLY;BYMONTH=11;BYDAY=4TH", 4), ["2026-11-26", "2027-11-25", "2028-11-23", "2029-11-22"]);
  assert.deepEqual(days("2026-05-10T09:00:00Z", "FREQ=YEARLY;BYMONTH=5;BYDAY=2SU", 3), ["2026-05-10", "2027-05-09", "2028-05-14"]);
  assert.deepEqual(days("2026-03-29T01:00:00Z", "FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", 3), ["2026-03-29", "2027-03-28", "2028-03-26"]);
  assert.equal(describeRule(rule("FREQ=YEARLY;BYMONTH=11;BYDAY=4TH")), "Every year on 4th Thu in Nov");
  assert.equal(describeRule(rule("FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU")), "Every year on last Sun in Mar");
});

test("YEARLY + BYMONTH: several months a year, on the start's day; the time of day is kept", () => {
  assert.deepEqual(occurrences("2026-01-15T08:30:00.000Z", rule("FREQ=YEARLY;BYMONTH=1,7;COUNT=4")), [
    "2026-01-15T08:30:00.000Z",
    "2026-07-15T08:30:00.000Z",
    "2027-01-15T08:30:00.000Z",
    "2027-07-15T08:30:00.000Z",
  ]);
  // A start on the 31st skips the months without one.
  assert.deepEqual(days("2026-01-31T00:00:00Z", "FREQ=YEARLY;BYMONTH=1,4,5;COUNT=4"), ["2026-01-31", "2026-05-31", "2027-01-31", "2027-05-31"]);
});

test("YEARLY + BYDAY without BYMONTH counts weeks in the year (20MO, -1FR)", () => {
  assert.deepEqual(days("2026-05-18T00:00:00Z", "FREQ=YEARLY;BYDAY=20MO", 3), ["2026-05-18", "2027-05-17", "2028-05-15"]);
  assert.deepEqual(days("2026-12-25T00:00:00Z", "FREQ=YEARLY;BYDAY=-1FR", 2), ["2026-12-25", "2027-12-31"]);
  assert.equal(parseRRule("FREQ=YEARLY;BYDAY=54MO"), null);
  assert.equal(parseRRule("FREQ=YEARLY;BYMONTH=2;BYDAY=6MO"), null, "within a month an ordinal stops at 5");
});

test("MONTHLY + BYMONTHDAY: the 1st and 15th, the last day, and Friday the 13th", () => {
  assert.deepEqual(days("2026-11-01T09:00:00Z", "FREQ=MONTHLY;BYMONTHDAY=1,15;COUNT=5"), ["2026-11-01", "2026-11-15", "2026-12-01", "2026-12-15", "2027-01-01"]);
  assert.deepEqual(days("2026-01-31T09:00:00Z", "FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=4"), ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  assert.deepEqual(days("2026-02-13T09:00:00Z", "FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13;COUNT=3"), ["2026-02-13", "2026-03-13", "2026-11-13"]);
  assert.equal(describeRule(rule("FREQ=MONTHLY;BYMONTHDAY=1,15")), "Every month on the 1st, the 15th");
  assert.equal(describeRule(rule("FREQ=MONTHLY;BYMONTHDAY=-1")), "Every month on the last day");
  assert.equal(describeRule(rule("FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13")), "Every month on the 13th if a Fri");
});

test("BYMONTH limits the other frequencies: a weekly class that only runs in term time", () => {
  assert.deepEqual(days("2026-08-24T10:00:00Z", "FREQ=WEEKLY;BYDAY=MO;BYMONTH=9,10;COUNT=3"), ["2026-08-24", "2026-09-07", "2026-09-14"]);
  assert.deepEqual(days("2026-11-28T10:00:00Z", "FREQ=DAILY;BYMONTH=12;COUNT=3"), ["2026-11-28", "2026-12-01", "2026-12-02"]);
  assert.deepEqual(days("2026-11-25T10:00:00Z", "FREQ=MONTHLY;BYMONTH=1,6;COUNT=3"), ["2026-11-25", "2027-01-25", "2027-06-25"]);
});

test("rules that can never match end, and bad parts are refused", () => {
  assert.deepEqual(days("2026-01-01T00:00:00Z", "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30"), ["2026-01-01"], "only the start itself");
  for (const bad of ["FREQ=YEARLY;BYMONTH=13", "FREQ=YEARLY;BYMONTH=0", "FREQ=MONTHLY;BYMONTHDAY=32", "FREQ=MONTHLY;BYMONTHDAY=0", "FREQ=WEEKLY;BYMONTHDAY=1", "FREQ=MONTHLY;BYMONTHDAY=x"]) {
    assert.equal(parseRRule(bad), null, bad);
  }
});

const ics = (lines: string[]) =>
  ["BEGIN:VCALENDAR", "METHOD:REQUEST", "BEGIN:VEVENT", "UID:rd-1@example.org", "SUMMARY:Board meeting", "DTSTART:20261203T150000Z", ...lines, "END:VEVENT", "END:VCALENDAR"].join("\r\n");

test("RDATE: extra dates join the series (not counted by COUNT), EXDATE still removes, and it round-trips", () => {
  const invite = parseInvite(ics(["RRULE:FREQ=MONTHLY;BYDAY=1TH;COUNT=2", "RDATE:20261215T150000Z,20270120T150000Z", "RDATE;VALUE=PERIOD:20270201T150000Z/PT1H", "EXDATE:20270107T150000Z"]));
  assert.ok(invite);
  assert.deepEqual(invite.rdates, ["2026-12-15T15:00:00.000Z", "2027-01-20T15:00:00.000Z"], "PERIOD values are skipped");
  const rows = expandEvents([invite], new Date("2026-12-01T00:00:00Z"), 90);
  assert.deepEqual(rows.map((row) => row.sort.slice(0, 10)), ["2026-12-03", "2026-12-15", "2027-01-20"], "COUNT=2 gives Dec 3 and Jan 7; Jan 7 is excluded");
  // Settings keep them, and the calendar feed publishes them.
  const kept = sanitizeSettings({ ...defaultSettings(), events: [invite] }).events[0] as CalEvent;
  assert.deepEqual(kept.rdates, invite.rdates);
  const feed = feedIcs([kept], "Test", new Date("2026-12-01T00:00:00Z"));
  assert.match(feed, /RDATE:20261215T150000Z\r\nRDATE:20270120T150000Z/);
});

test("RDATE without RRULE: the start plus each date", () => {
  const invite = parseInvite(ics(["RDATE:20261210T150000Z", "RDATE:20261217T150000Z"]));
  assert.ok(invite && !invite.rrule);
  const rows = expandEvents([invite], new Date("2026-12-01T00:00:00Z"), 60);
  assert.deepEqual(rows.map((row) => row.sort.slice(0, 10)), ["2026-12-03", "2026-12-10", "2026-12-17"]);
  assert.match(rows[0]!.whenLabel, /one of 3 dates$/);
});
