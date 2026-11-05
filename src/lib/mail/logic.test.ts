import assert from "node:assert/strict";
import { test } from "node:test";
import { listThreads, planDelivery } from "./logic.ts";
import { ME, SEED_MESSAGES, type MailMessage } from "./model.ts";

test("Cumulus recipients stay inside and everyone else is outbound", () => {
  const hops = planDelivery([
    { name: "Leah", email: "leah@cumulusmail.cloud" },
    { name: "Priya", email: "priya.shah@vyral.example" },
    { name: "Leah again", email: "Leah@cumulusmail.cloud" },
  ]);
  assert.equal(hops.length, 2);
  assert.equal(hops[0]?.status, "inside");
  assert.equal(hops[1]?.status, "outbound");
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
  assert.equal(ME.email.endsWith("@cumulusmail.cloud"), true);
});
