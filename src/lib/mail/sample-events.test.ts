import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { openMailbox } from "./mailbox.ts";
import { EVENTS } from "./model.ts";
import { createHarness, profile } from "./test-support.ts";

let harness: Awaited<ReturnType<typeof createHarness>>;
before(async () => {
  harness = await createHarness();
});
after(async () => {
  await harness.close();
});

test("a real mailbox's calendar starts empty: no sample meetings", async () => {
  const snapshot = await openMailbox(harness.db, "cal-real", profile("cal-real", "cal.real@cumuluscloud.app", "Cal Real"));
  assert.deepEqual(snapshot.settings?.events, []);
  assert.equal(snapshot.messages.length, 0, "and no sample mail, as before");
});

test("the preview mailbox keeps the sample calendar, as its own events", async () => {
  const snapshot = await openMailbox(harness.db, "alex", profile("alex", "alex@cumuluscloud.app", "Alex Reid"));
  assert.ok(EVENTS.length > 0);
  assert.deepEqual(
    snapshot.settings?.events.map((event) => event.id),
    EVENTS.map((event) => event.id),
  );
});
