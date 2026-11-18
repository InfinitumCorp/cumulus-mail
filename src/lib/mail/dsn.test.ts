import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createBounceHandler, parseDsn, quotedMessageIds } from "./dsn.ts";
import { insertMessage } from "./records.ts";
import type { MailMessage } from "./model.ts";
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

/** A bounce as an MTA sends it: the report, then the original message's headers (RFC 3462). */
function bounce(recipient: string, status: string, quotedMessageId?: string): string {
  return [
    "From: Mail Delivery System <MAILER-DAEMON@mx.example.test>",
    "Message-ID: <bounce-1@mx.example.test>",
    "Content-Type: multipart/report; report-type=delivery-status; boundary=b",
    "",
    "--b",
    "Content-Type: text/plain",
    "",
    "Delivery failed.",
    "--b",
    "Content-Type: message/delivery-status",
    "",
    "Reporting-MTA: dns; mx.example.test",
    "",
    `Final-Recipient: rfc822; ${recipient}`,
    "Action: failed",
    `Status: ${status}`,
    "Diagnostic-Code: smtp; 550 user unknown",
    "--b",
    "Content-Type: text/rfc822-headers",
    "",
    "From: Ada <dsn.ada@cumuluscloud.app>",
    `To: ${recipient}`,
    ...(quotedMessageId ? [`Message-ID: <${quotedMessageId}@cumuluscloud.app>`] : []),
    "Subject: Hello",
    "--b--",
    "",
  ].join("\r\n");
}

function sent(id: string, folder: MailMessage["folder"], to: string[], cc: string[] = []): MailMessage {
  return {
    id,
    threadId: id,
    folder,
    from: { name: "Ada", email: "dsn.ada@cumuluscloud.app" },
    to: to.map((email) => ({ name: email, email })),
    cc: cc.map((email) => ({ name: email, email })),
    subject: "Hello",
    body: "hi",
    at: "2026-11-18T09:00:00.000Z",
    unread: false,
    starred: false,
    labels: [],
  };
}

test("a bounce for mail this mailbox sent suppresses the failed recipient, for that mailbox only", async () => {
  const { db } = harness;
  await openMailbox(db, "dsn-ada", profile("dsn-ada", "dsn.ada@cumuluscloud.app", "Ada"));
  await openMailbox(db, "dsn-bea", profile("dsn-bea", "dsn.bea@cumuluscloud.app", "Bea"));
  await insertMessage(db, "dsn-ada", sent("out-gone", "sent", ["gone@example.test"], ["cc@example.test"]), null);
  const receipts = await createBounceHandler(db, "dsn-ada").accept(bounce("gone@example.test", "5.1.1", "out-gone"));
  assert.equal(receipts[0]?.suppressed, true);
  assert.equal(await createSuppressionList(db, "dsn-ada").has("gone@example.test"), true);
  assert.equal(await createSuppressionList(db, "dsn-bea").has("gone@example.test"), false);
  const rows = await db.query<{ status: string }>(`select status from cumulus_mail.bounces where tenant_id = $1`, ["dsn-ada"]);
  assert.equal(rows[0]?.status, "5.1.1");
  // A Cc recipient of the same message counts too; a transient failure is recorded but suppresses nothing.
  const later = await createBounceHandler(db, "dsn-ada").accept(bounce("cc@example.test", "4.2.2", "out-gone"));
  assert.equal(later[0]?.suppressed, false);
  assert.equal(await createSuppressionList(db, "dsn-ada").has("cc@example.test"), false);
});

test("a forged bounce cannot suppress anyone: it must quote a message this mailbox sent to that address", async () => {
  const { db } = harness;
  await openMailbox(db, "dsn-cat", profile("dsn-cat", "dsn.cat@cumuluscloud.app", "Cat"));
  await openMailbox(db, "dsn-dan", profile("dsn-dan", "dsn.dan@cumuluscloud.app", "Dan"));
  await insertMessage(db, "dsn-cat", sent("cat-out", "sent", ["friend@example.test"]), null);
  await insertMessage(db, "dsn-cat", sent("cat-in", "inbox", ["boss@example.test"]), null);
  await insertMessage(db, "dsn-dan", sent("dan-out", "sent", ["boss@example.test"]), null);
  const handler = createBounceHandler(db, "dsn-cat");
  for (const [label, raw] of [
    ["quotes no message", bounce("boss@example.test", "5.1.1")],
    ["quotes a message sent to someone else", bounce("boss@example.test", "5.1.1", "cat-out")],
    ["quotes a message Cat received, not sent", bounce("boss@example.test", "5.1.1", "cat-in")],
    ["quotes another mailbox's sent message", bounce("boss@example.test", "5.1.1", "dan-out")],
    ["quotes a made-up id", bounce("boss@example.test", "5.1.1", "made-up-id")],
  ] as const) {
    assert.deepEqual(await handler.accept(raw), [], label);
  }
  assert.equal(await createSuppressionList(db, "dsn-cat").has("boss@example.test"), false);
  const rows = await db.query(`select 1 from cumulus_mail.bounces where tenant_id = $1`, ["dsn-cat"]);
  assert.equal(rows.length, 0, "nothing recorded either");
});

test("parsing: angle-bracketed recipients, several recipients, X-Failed-Recipients bounces, quoted ids", () => {
  const multi = [
    "Content-Type: message/delivery-status",
    "",
    "Reporting-MTA: dns; mx.example.test",
    "",
    "Final-Recipient: rfc822;<One@Example.test>",
    "Action: failed",
    "Status: 5.1.1",
    "",
    "Original-Recipient: rfc822;two@example.test",
    "Action: delayed",
    "Status: 4.4.1",
  ].join("\r\n");
  assert.deepEqual(parseDsn(multi).map((r) => [r.recipient, r.action, r.status]), [
    ["one@example.test", "failed", "5.1.1"],
    ["two@example.test", "delayed", "4.4.1"],
  ]);
  const exim = ["From: Mail Delivery System <Mailer-Daemon@mx.example.test>", "X-Failed-Recipients: a@example.test,", " <b@example.test>", "Subject: Mail delivery failed", "", "This message was created automatically by mail delivery software."].join("\r\n");
  assert.deepEqual(parseDsn(exim).map((r) => [r.recipient, r.status]), [["a@example.test", "5.0.0"], ["b@example.test", "5.0.0"]]);
  assert.deepEqual(quotedMessageIds(bounce("x@example.test", "5.1.1", "out-7")), ["bounce-1", "out-7"]);
});
