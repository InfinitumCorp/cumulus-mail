import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { openMailbox, writeSnapshot } from "./mailbox.ts";
import { readSnapshot } from "./records.ts";
import { createHarness, profile } from "./test-support.ts";

let harness: Awaited<ReturnType<typeof createHarness>>;
before(async () => {
  harness = await createHarness();
});
after(async () => {
  await harness.close();
});

test("a new real mailbox starts with setup pending; finishing it clears the flag", async () => {
  const snapshot = await openMailbox(harness.db, "setup-new", profile("setup-new", "setup.new@cumuluscloud.app", "setup.new"));
  assert.equal(snapshot.settings?.setupPending, true);
  await writeSnapshot(harness.db, harness.storageFor, "setup-new", { ...snapshot, settings: { ...snapshot.settings!, setupPending: false } });
  assert.equal((await readSnapshot(harness.db, "setup-new")).settings?.setupPending, false);
  // Opening it again (the next visit) does not bring the card back.
  assert.equal((await openMailbox(harness.db, "setup-new", profile("setup-new", "setup.new@cumuluscloud.app"))).settings?.setupPending, false);
});

test("the display name is the owner's to change, cleaned; the address never changes from a snapshot", async () => {
  const snapshot = await openMailbox(harness.db, "setup-name", profile("setup-name", "setup.name@cumuluscloud.app", "setup.name"));
  await writeSnapshot(harness.db, harness.storageFor, "setup-name", {
    ...snapshot,
    me: { ...snapshot.me, name: '  Ada\r\nBcc: x@evil.example "Lovelace"  ', email: "ceo@cumuluscloud.app" },
  });
  const after = await readSnapshot(harness.db, "setup-name");
  assert.equal(after.me.name, "Ada Bcc: x@evil.example Lovelace", "no line breaks or quotes survive");
  assert.equal(after.me.email, "setup.name@cumuluscloud.app", "the address is not the client's to set");
  // An empty name keeps the current one.
  await writeSnapshot(harness.db, harness.storageFor, "setup-name", { ...after, me: { ...after.me, name: "   " } });
  assert.equal((await readSnapshot(harness.db, "setup-name")).me.name, "Ada Bcc: x@evil.example Lovelace");
});
