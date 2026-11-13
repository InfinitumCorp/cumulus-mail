import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import handler from "../../../workers/email/src/index.ts";
import { ingestInboundEmail, overQuotaWith, storageEnforced } from "./inbound.ts";
import { openMailbox } from "./mailbox.ts";
import { newMailboxPlan, PLANS } from "./plans.ts";
import { readSnapshot } from "./records.ts";
import { createHarness, profile } from "./test-support.ts";

let harness: Awaited<ReturnType<typeof createHarness>>;
before(async () => {
  harness = await createHarness();
});
after(async () => {
  await harness.close();
});

const raw = (to: string, subject: string) =>
  new TextEncoder().encode(
    [`From: Leah <leah@example.com>`, `To: ${to}`, `Subject: ${subject}`, "Content-Type: text/plain", "", "Hello."].join("\r\n"),
  );

/** Make a mailbox look like it stores `bytes` without writing that much: one large attachment row. */
async function fill(tenantId: string, bytes: number) {
  const db = harness.db;
  await db.query(
    `insert into cumulus_mail.messages (tenant_id, id, thread_id, folder, from_name, from_email, to_json, cc_json,
       subject, body, sent_at, unread, starred, labels_json)
     values ($1, 'big', 'big', 'inbox', 'x', 'x@example.com', '[]', '[]', 's', 'b', '2026-11-01T00:00:00Z', false, false, '[]')`,
    [tenantId],
  );
  await db.query(
    `insert into cumulus_mail.attachments (tenant_id, id, message_id, name, size, content_type, sha256, object_key)
     values ($1, 'big-file', 'big', 'big.bin', $2, 'application/octet-stream', 'x', 'x')`,
    [tenantId, bytes],
  );
}

test("the plan a new mailbox starts on is a switch; unset or unknown keeps Plus", async () => {
  assert.equal(newMailboxPlan({}), "plus");
  assert.equal(newMailboxPlan({ MAIL_DEFAULT_PLAN: " Free " }), "free");
  assert.equal(newMailboxPlan({ MAIL_DEFAULT_PLAN: "enterprise" }), "plus");

  const keep = process.env.MAIL_DEFAULT_PLAN;
  try {
    process.env.MAIL_DEFAULT_PLAN = "free";
    await openMailbox(harness.db, "sw-new", profile("sw-new", "sw.new@cumuluscloud.app", "New"));
    const fresh = await readSnapshot(harness.db, "sw-new");
    assert.deepEqual(fresh.me.limits, PLANS.free);
    assert.equal(fresh.me.plan, "Free");
    assert.equal(fresh.me.quotaGb, 1);

    // Existing mailboxes are not moved by the switch.
    delete process.env.MAIL_DEFAULT_PLAN;
    await openMailbox(harness.db, "sw-old", profile("sw-old", "sw.old@cumuluscloud.app", "Old"));
    process.env.MAIL_DEFAULT_PLAN = "free";
    await openMailbox(harness.db, "sw-old", profile("sw-old", "sw.old@cumuluscloud.app", "Old"));
    assert.deepEqual((await readSnapshot(harness.db, "sw-old")).me.limits, PLANS.plus);
  } finally {
    if (keep === undefined) delete process.env.MAIL_DEFAULT_PLAN;
    else process.env.MAIL_DEFAULT_PLAN = keep;
  }
});

test("storage enforcement is off by default; when on, a full mailbox refuses new mail before storing it", async () => {
  assert.equal(storageEnforced(undefined), false);
  assert.equal(storageEnforced("0"), false);
  assert.equal(storageEnforced("1"), true);
  assert.equal(storageEnforced("TRUE"), true);

  const db = harness.db;
  // sw-new is on Free (1 GB). Fill it to just under the quota.
  await fill("sw-new", 999_999_900);
  assert.equal(await overQuotaWith(db, "sw-new", 50), false);
  assert.equal(await overQuotaWith(db, "sw-new", 500), true);

  const to = "sw.new@cumuluscloud.app";
  // Off: accepted as before, even over quota.
  const accepted = await ingestInboundEmail(db, harness.storageFor, { from: "leah@example.com", to, raw: raw(to, "Off") });
  assert.equal(accepted.stored.length, 1);
  assert.equal(accepted.rejected, undefined);

  // On: refused, and nothing stored.
  const before = (await readSnapshot(db, "sw-new")).messages.length;
  const refused = await ingestInboundEmail(db, harness.storageFor, { from: "leah@example.com", to, raw: raw(to, "On") }, undefined, {
    enforceStorage: true,
  });
  assert.deepEqual(refused, { stored: [], rejected: "mailbox_full" });
  assert.equal((await readSnapshot(db, "sw-new")).messages.length, before);

  // A mailbox with room still gets mail with enforcement on.
  const plusTo = "sw.old@cumuluscloud.app";
  const ok = await ingestInboundEmail(db, harness.storageFor, { from: "leah@example.com", to: plusTo, raw: raw(plusTo, "Room") }, undefined, {
    enforceStorage: true,
  });
  assert.equal(ok.stored.length, 1);
});

test("the inbound worker answers a full mailbox with 552 only when MAIL_ENFORCE_STORAGE is on", async () => {
  const to = "sw.new@cumuluscloud.app";
  const ingest = { db: harness.db, storageFor: harness.storageFor };
  const replies: string[] = [];
  await handler.email(
    { from: "leah@example.com", to, raw: raw(to, "Worker on"), setReject: (reason: string) => replies.push(reason) },
    { ingest, MAIL_ENFORCE_STORAGE: "1" },
  );
  assert.deepEqual(replies, ["552 5.2.2 Mailbox full"]);

  await handler.email(
    { from: "leah@example.com", to, raw: raw(to, "Worker off"), setReject: (reason: string) => replies.push(reason) },
    { ingest },
  );
  assert.equal(replies.length, 1);
});
