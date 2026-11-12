import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness, profile } from "../../../src/lib/mail/test-support.ts";
import { openMailbox } from "../../../src/lib/mail/mailbox.ts";
import { insertMessage, readSnapshot } from "../../../src/lib/mail/records.ts";
import handler, { handleEmail, handleScheduled } from "./index.ts";

const RAW = new TextEncoder().encode(
  [
    "From: Leah <leah@cumuluscloud.app>",
    "To: Ada <worker.ada@cumuluscloud.app>",
    "Subject: Worker",
    "Content-Type: text/plain",
    "",
    "Stored by the email handler.",
  ].join("\r\n"),
);

test("the email handler refuses to run without an ingest binding", async () => {
  await assert.rejects(
    () => handleEmail({ from: "leah@cumuluscloud.app", to: "ada@cumuluscloud.app", raw: RAW }, {}),
    /not deployed/,
  );
});

test("the email handler parses MIME and stores it through the storage adapter", async () => {
  const harness = await createHarness();
  try {
    await openMailbox(harness.db, "worker-ada", profile("worker-ada", "worker.ada@cumuluscloud.app", "Ada"));
    const result = await handler.email(
      { from: "leah@cumuluscloud.app", to: "worker.ada@cumuluscloud.app", raw: RAW },
      { ingest: { db: harness.db, storageFor: harness.storageFor } },
    );
    assert.equal(result, undefined);
    const box = await readSnapshot(harness.db, "worker-ada");
    const message = box.messages.find((item) => item.subject === "Worker");
    assert.equal(message?.body, "Stored by the email handler.");
    assert.ok(message);
    const rawRows = await harness.db.query<{ raw_key: string }>(
      `select raw_key from cumulus_mail.messages where tenant_id = $1 and id = $2`,
      ["worker-ada", message.id],
    );
    const raw = await harness.storageFor("worker-ada").get(rawRows[0]?.raw_key ?? "");
    assert.equal(raw?.body.byteLength, RAW.byteLength);
  } finally {
    await harness.close();
  }
});

test("the cron handler releases a due scheduled draft through the worker ingest", async () => {
  const harness = await createHarness();
  try {
    const me = profile("worker-cron", "worker.cron@cumuluscloud.app", "Cron");
    await openMailbox(harness.db, "worker-cron", me);
    await insertMessage(
      harness.db,
      "worker-cron",
      {
        id: "cron-1",
        threadId: "cron-t1",
        folder: "drafts",
        from: { name: me.name, email: me.email },
        to: [{ name: "Out", email: "out@example.org" }],
        cc: [],
        subject: "Cron",
        body: "Sent by the cron.",
        at: "2026-01-01T00:00:00.000Z",
        unread: false,
        starred: false,
        labels: [],
        extra: { scheduleAt: "2000-01-01T00:00:00.000Z" },
      },
      null,
    );
    const result = await handler.scheduled(
      { scheduledTime: Date.now() },
      { ingest: { db: harness.db, storageFor: harness.storageFor } },
    );
    assert.equal(result, undefined);
    const box = await readSnapshot(harness.db, "worker-cron");
    assert.equal(box.messages.find((item) => item.id === "cron-1")?.folder, "sent");
    await assert.rejects(() => handleScheduled({}), /not deployed/);
  } finally {
    await harness.close();
  }
});

test("the cron handler also sends due outbound rows when SMTP is configured, and skips them when it is not", async () => {
  const { enqueueOutbound } = await import("../../../src/lib/mail/outbound/queue.ts");
  const { createMemoryTransport } = await import("../../../src/lib/mail/outbound/transport.ts");
  const harness = await createHarness();
  try {
    const me = profile("worker-out", "worker.out@cumuluscloud.app", "Out");
    await openMailbox(harness.db, "worker-out", me);
    await enqueueOutbound(harness.db, "worker-out", {
      messageId: "out-1",
      from: me.email,
      recipient: "bea@example.org",
      raw: "Subject: hi\r\n\r\nhello\r\n",
    });
    const ingest = { db: harness.db, storageFor: harness.storageFor };

    const off = await handleScheduled({ ingest, outbound: null });
    assert.equal(off.outbound, null);

    const transport = createMemoryTransport();
    const on = await handleScheduled({ ingest, outbound: { transport, dkim: null } });
    assert.deepEqual(on.outbound, { sent: 1, retried: 0, bounced: 0 });
    assert.deepEqual(transport.sent.map((item) => item.to), [["bea@example.org"]]);

    // Already sent: the next run has nothing to do.
    const again = await handleScheduled({ ingest, outbound: { transport, dkim: null } });
    assert.deepEqual(again.outbound, { sent: 0, retried: 0, bounced: 0 });
    // No SMTP settings in the bindings means off.
    assert.equal((await handleScheduled({ ingest })).outbound, null);
  } finally {
    await harness.close();
  }
});

test("on Workers, SMTP settings in the bindings send through the Workers socket dialer", async () => {
  const { enqueueOutbound } = await import("../../../src/lib/mail/outbound/queue.ts");
  const { dialWith } = await import("../../../src/lib/mail/outbound/cf-socket.ts");
  const { fakeConnect } = await import("../../../src/lib/mail/outbound/cf-fake.ts");
  const harness = await createHarness();
  try {
    const me = profile("worker-cf", "worker.cf@cumuluscloud.app", "Cf");
    await openMailbox(harness.db, "worker-cf", me);
    await enqueueOutbound(harness.db, "worker-cf", { messageId: "cf-1", from: me.email, recipient: "bea@example.org", raw: "Subject: hi\r\n\r\nhello\r\n" });
    const log = { connects: [] as Array<{ host: string; port: number; secure: string }>, lines: [] as string[], tls: 0 };
    const report = await handleScheduled({
      ingest: { db: harness.db, storageFor: harness.storageFor },
      MAIL_SMTP_HOST: "smtp.example.org",
      smtpDial: dialWith(fakeConnect(log)),
    });
    assert.deepEqual(report.outbound, { sent: 1, retried: 0, bounced: 0 });
    assert.deepEqual(log.connects, [{ host: "smtp.example.org", port: 587, secure: "starttls" }]);
  } finally {
    await harness.close();
  }
});
