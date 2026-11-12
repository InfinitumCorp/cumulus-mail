import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { quota } from "./logic.ts";
import { openMailbox, writeSnapshot } from "./mailbox.ts";
import type { MailMessage } from "./model.ts";
import { readSnapshot, storageUsedBytes } from "./records.ts";
import { createHarness, profile } from "./test-support.ts";

let harness: Awaited<ReturnType<typeof createHarness>>;
before(async () => {
  harness = await createHarness();
});
after(async () => {
  await harness.close();
});

const message = (id: string, body: string): MailMessage => ({
  id,
  threadId: id,
  folder: "inbox",
  from: { name: "Bea", email: "bea@example.com" },
  to: [{ name: "Ada", email: "use.ada@cumuluscloud.app" }],
  cc: [],
  subject: `Subject ${id}`,
  body,
  at: "2026-11-01T10:00:00.000Z",
  unread: true,
  starred: false,
  labels: [],
});

test("quota: the server's count when there is one, the old estimate otherwise, soft warnings at 90%", () => {
  const measured = quota([], 15, 1_500_000_000);
  assert.equal(measured.label, "1.50 GB of 15 GB");
  assert.equal(measured.measured, true);
  assert.equal(measured.warning, null);
  assert.equal(quota([], 1, 900_000_000).warning, "near");
  assert.equal(quota([], 1, 1_200_000_000).warning, "over");
  assert.equal(quota([], 1, 1_200_000_000).pct, 100);
  assert.equal(quota([], 15, 1234).label, "<0.01 GB of 15 GB");
  assert.equal(quota([], 15, 0).label, "0.00 GB of 15 GB");
  const estimate = quota([], 15);
  assert.equal(estimate.measured, false);
  assert.equal(estimate.label, "2.41 GB of 15 GB");
  assert.equal(quota([], 0, 10).warning, "over");
});

test("storage is counted per mailbox on the server and grows with stored mail", async () => {
  const db = harness.db;
  const ada = await openMailbox(db, "use-ada", profile("use-ada", "use.ada@cumuluscloud.app", "Ada"));
  await openMailbox(db, "use-bea", profile("use-bea", "use.bea@cumuluscloud.app", "Bea"));
  const before = await storageUsedBytes(db, "use-ada");
  const beaBefore = await storageUsedBytes(db, "use-bea");
  assert.equal(ada.me.usedBytes, before);

  await writeSnapshot(db, harness.storageFor, "use-ada", { ...ada, messages: [...ada.messages, message("use-big", "x".repeat(200_000))] });
  const after = await storageUsedBytes(db, "use-ada");
  // Sealed text is larger than the plain text, never smaller.
  assert.ok(after - before >= 200_000, `${after} - ${before}`);
  assert.equal((await readSnapshot(db, "use-ada")).me.usedBytes, after);
  assert.equal(await storageUsedBytes(db, "use-bea"), beaBefore);
  await assert.rejects(() => storageUsedBytes(db, "../x"));
});
