import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createBounceHandler, parseDsn } from "./dsn.ts";
import { openMailbox } from "./mailbox.ts";
import { createSuppressionList } from "./suppression.ts";
import { createHarness, profile } from "./test-support.ts";

const RAW = [
  "Content-Type: multipart/report; report-type=delivery-status; boundary=b",
  "",
  "--b",
  "Content-Type: text/plain",
  "",
  "Delivery failed.",
  "--b",
  "Content-Type: message/delivery-status",
  "",
  "Reporting-MTA: dns; mail.example.test",
  "Final-Recipient: rfc822; gone@example.test",
  "Action: failed",
  "Status: 5.1.1",
  "Diagnostic-Code: smtp; 550 user unknown",
  "--b--",
  "",
].join("\n");

test("a DSN names the failed recipient and the status", () => {
  const reports = parseDsn(RAW);
  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.recipient, "gone@example.test");
  assert.equal(reports[0]?.status, "5.1.1");
  assert.equal(reports[0]?.action, "failed");
});

let harness: Awaited<ReturnType<typeof createHarness>>;

before(async () => {
  harness = await createHarness();
});

after(async () => {
  await harness.close();
});

test("a permanent DSN suppresses the recipient for that tenant only", async () => {
  const { db } = harness;
  await openMailbox(db, "dsn-ada", profile("dsn-ada", "dsn.ada@cumuluscloud.app", "Ada"));
  await openMailbox(db, "dsn-bea", profile("dsn-bea", "dsn.bea@cumuluscloud.app", "Bea"));
  const receipts = await createBounceHandler(db, "dsn-ada").accept(RAW);
  assert.equal(receipts[0]?.suppressed, true);
  assert.equal(await createSuppressionList(db, "dsn-ada").has("gone@example.test"), true);
  assert.equal(await createSuppressionList(db, "dsn-bea").has("gone@example.test"), false);
  const rows = await db.query<{ status: string }>(
    `select status from cumulus_mail.bounces where tenant_id = $1`,
    ["dsn-ada"],
  );
  assert.equal(rows[0]?.status, "5.1.1");
});
