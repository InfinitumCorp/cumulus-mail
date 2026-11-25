import assert from "node:assert/strict";
import { test } from "node:test";
import { shareRequest } from "./calendar-share.ts";

test("a shared invitation takes only a real address, and its text cannot add iCalendar lines", () => {
  const event = { id: "e1", title: "Plan; review, then\r\nATTENDEE:mailto:eve@example.com", whenLabel: "", where: "Room 1\nBEGIN:VALARM", with: "", sort: "2026-11-19T15:00:00.000Z" };
  assert.throws(() => shareRequest(event, { name: "Ada", email: "ada@cumuluscloud.app" }, "bea@cumuluscloud.app\r\nATTENDEE:mailto:eve@example.com", "m1"));
  assert.throws(() => shareRequest(event, { name: "Ada", email: "ada@cumuluscloud.app" }, "not an address", "m1"));
  const message = shareRequest(event, { name: "Ada", email: "ada@cumuluscloud.app" }, " Bea@CumulusCloud.app ", "m1");
  assert.deepEqual(message.to, [{ name: "bea@cumuluscloud.app", email: "bea@cumuluscloud.app" }]);
  const lines = message.body.split("\r\n");
  assert.equal(lines.filter((line) => line.startsWith("ATTENDEE:")).length, 1);
  assert.equal(lines.some((line) => line.startsWith("BEGIN:VALARM")), false);
  assert.ok(lines.includes("SUMMARY:Plan\\; review\\, then\\nATTENDEE:mailto:eve@example.com"));
});
