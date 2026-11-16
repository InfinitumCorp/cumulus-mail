import assert from "node:assert/strict";
import { test } from "node:test";
import { formatShort, formatWhen, localWhenLabel, zoneLabel } from "./logic.ts";
import { detectTimeZone } from "../viewer-time-zone.ts";

const AT = "2026-11-05T22:30:00.000Z";

test("UTC stays the default, so the server render and the first client render agree", () => {
  assert.equal(formatWhen(AT), "Thu 05 Nov, 22:30");
  assert.equal(formatShort(AT), "05 Nov");
  assert.equal(zoneLabel(AT), "UTC");
});

test("in the viewer's zone: the time, the day (across midnight) and the offset follow", () => {
  assert.equal(formatWhen(AT, "Europe/Moscow"), "Fri 06 Nov, 01:30");
  assert.equal(formatShort(AT, "Europe/Moscow"), "06 Nov");
  assert.equal(zoneLabel(AT, "Europe/Moscow"), "GMT+3");
  assert.equal(formatWhen(AT, "America/New_York"), "Thu 05 Nov, 17:30");
  assert.equal(zoneLabel(AT, "America/New_York"), "GMT-5");
  assert.equal(zoneLabel("2026-07-05T12:00:00Z", "America/New_York"), "GMT-4", "summer time");
  assert.equal(zoneLabel(AT, "Asia/Kolkata"), "GMT+5:30");
  assert.equal(zoneLabel(AT, "Europe/London"), "UTC", "zero offset reads as UTC");
});

test("calendar labels: the UTC start becomes local; the rest of the label and other labels are kept", () => {
  const iso = "2026-11-26T17:00:00.000Z";
  assert.equal(localWhenLabel("2026-11-26 17:00 UTC · Every year on 4th Thu in Nov", iso, "Europe/Moscow"), "2026-11-26 20:00 GMT+3 · Every year on 4th Thu in Nov");
  assert.equal(localWhenLabel("2026-11-26 17:00 UTC", iso, "Asia/Tokyo"), "2026-11-27 02:00 GMT+9");
  assert.equal(localWhenLabel("Thu 5 Nov · 15:00 ET", iso, "Europe/Moscow"), "Thu 5 Nov · 15:00 ET", "written by hand: left alone");
  assert.equal(localWhenLabel("2026-11-26 17:00 UTC", iso, "UTC"), "2026-11-26 17:00 UTC");
  assert.equal(localWhenLabel("2026-11-26 17:00 UTC", "not a date", "Europe/Moscow"), "2026-11-26 17:00 UTC");
});

test("the detected zone is one Intl accepts", () => {
  const zone = detectTimeZone();
  assert.doesNotThrow(() => new Intl.DateTimeFormat("en-GB", { timeZone: zone }).format(0));
});
