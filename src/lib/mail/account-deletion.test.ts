import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  cancelDeletion,
  deletionStatus,
  GRACE_MS,
  purgeDueDeletions,
  purgeMailbox,
  requestDeletion,
  subjectHmac,
  tenantTables,
} from "./account-deletion.ts";
import { openMailbox } from "./mailbox.ts";
import type { MailMessage } from "./model.ts";
import { insertAttachment, insertMessage } from "./records.ts";
import { createSuppressionList } from "./suppression.ts";
import { createHarness, profile } from "./test-support.ts";

let harness: Awaited<ReturnType<typeof createHarness>>;
before(async () => {
  harness = await createHarness();
});
after(async () => {
  await harness.close();
});

const message = (id: string, over: Partial<MailMessage> = {}): MailMessage => ({
  id,
  threadId: id,
  folder: "inbox",
  from: { name: "Leah", email: "leah@cumuluscloud.app" },
  to: [{ name: "Alex", email: "alex@cumuluscloud.app" }],
  cc: [],
  subject: `Subject ${id}`,
  body: `Body of ${id}`,
  at: "2026-11-10T09:30:00.000Z",
  unread: true,
  starred: false,
  labels: [],
  ...over,
});

/** A mailbox with rows in as many tables as the app writes, and real blobs. */
async function populate(tenant: string) {
  const { db, storageFor } = harness;
  await openMailbox(db, tenant, profile(tenant, `${tenant}@cumuluscloud.app`, tenant));
  const storage = storageFor(tenant);
  const raw = await storage.put(new TextEncoder().encode(`From: x@example.com\r\n\r\nraw for ${tenant}`));
  const file = await storage.put(new TextEncoder().encode(`attachment for ${tenant}`));
  const shared = await storage.put(new TextEncoder().encode(`shared for ${tenant}`));
  await insertMessage(db, tenant, message(`${tenant}-in`), raw.blobId);
  await insertMessage(db, tenant, message(`${tenant}-out`, { folder: "sent" }), null);
  await insertAttachment(db, tenant, `${tenant}-out`, {
    id: `${tenant}-att`,
    name: "f.txt",
    size: 10,
    contentType: "text/plain",
    sha256: file.sha256,
    objectKey: file.blobId,
  });
  await db.query(
    `insert into cumulus_mail.share_grants (jti, tenant_id, blob_id, expires_at, revoked) values ($1, $2, $3, $4, false)`,
    [`${tenant}-jti`, tenant, shared.blobId, "2099-01-01T00:00:00Z"],
  );
  await db.query(`insert into cumulus_mail.contacts (tenant_id, id, name, email, org, note) values ($1, $2, 'C', 'c@example.com', '', '')`, [tenant, `${tenant}-c`]);
  await db.query(`insert into cumulus_mail.tasks (tenant_id, id, title, detail, done) values ($1, $2, 't', '', false)`, [tenant, `${tenant}-t`]);
  await db.query(`insert into cumulus_mail.rules (tenant_id, id, from_match, action) values ($1, $2, 'x@example.com', 'archive')`, [tenant, `${tenant}-r`]);
  await db.query(`insert into cumulus_mail.briefs (tenant_id, brief_key, body) values ($1, 'k', 'brief')`, [tenant]);
  await db.query(
    `insert into cumulus_mail.deliveries (message_id, sender_tenant, recipient, status, detail, at)
     select $2, $1, 'r@example.com', 'delivered', '', now()
     where exists (select 1 from information_schema.columns where table_schema='cumulus_mail' and table_name='deliveries' and column_name='recipient')`,
    [tenant, `${tenant}-in`],
  ).catch(() => undefined);
  await createSuppressionList(db, tenant).add("blocked@example.com", "user");
  return { raw, file, shared };
}

/** Rows anywhere in cumulus_mail that still name this mailbox, by table. */
async function leftovers(tenant: string): Promise<Record<string, number>> {
  const { db } = harness;
  const left: Record<string, number> = {};
  for (const { table, column } of await tenantTables(db)) {
    const rows = await db.query<{ n: number | string }>(`select count(*) as n from cumulus_mail.${table} where ${column} = $1`, [tenant]);
    const n = Number(rows[0]?.n ?? 0);
    if (n) left[`${table}.${column}`] = n;
  }
  const requests = await db.query<{ n: number | string }>(`select count(*) as n from cumulus_mail.account_deletions where tenant_id = $1`, [tenant]);
  if (Number(requests[0]?.n)) left["account_deletions"] = Number(requests[0]!.n);
  return left;
}

test("request, then cancel within the grace period: nothing is deleted", async () => {
  const { db } = harness;
  await populate("del-cancel");
  const now = new Date("2026-11-13T10:00:00Z");
  const { purgeAfter } = await requestDeletion(db, "del-cancel", now);
  assert.equal(purgeAfter, new Date(now.getTime() + GRACE_MS).toISOString());
  assert.equal(await cancelDeletion(db, "del-cancel", now), true);
  assert.equal((await deletionStatus(db, "del-cancel"))?.cancelled, true);
  // Long after the date it would have run: still there.
  const later = new Date(now.getTime() + 30 * GRACE_MS);
  await purgeDueDeletions(db, harness.storageFor, later);
  assert.ok(Object.keys(await leftovers("del-cancel")).length > 1, "the mailbox is untouched");
  assert.equal(await cancelDeletion(db, "del-cancel", later), false, "nothing left to cancel");
});

test("asking twice keeps the first date; asking after a cancel starts a new grace period", async () => {
  const { db } = harness;
  await populate("del-again");
  const t0 = new Date("2026-11-13T10:00:00Z");
  const first = await requestDeletion(db, "del-again", t0);
  const second = await requestDeletion(db, "del-again", new Date(t0.getTime() + 3_600_000));
  assert.equal(second.purgeAfter, first.purgeAfter);
  await cancelDeletion(db, "del-again", t0);
  const t1 = new Date(t0.getTime() + 2 * GRACE_MS);
  assert.equal((await requestDeletion(db, "del-again", t1)).purgeAfter, new Date(t1.getTime() + GRACE_MS).toISOString());
});

test("nothing happens before the grace period ends", async () => {
  const { db } = harness;
  await populate("del-early");
  const now = new Date("2026-11-13T10:00:00Z");
  await requestDeletion(db, "del-early", now);
  assert.deepEqual(await purgeDueDeletions(db, harness.storageFor, new Date(now.getTime() + GRACE_MS - 1)), { purged: 0 });
  assert.ok(Object.keys(await leftovers("del-early")).length > 1);
});

test("after the grace period NOTHING remains for the mailbox: no row in any table, no blob", async () => {
  const { db, storageFor } = harness;
  const blobs = await populate("del-gone");
  await populate("del-neighbour");
  const before = await leftovers("del-gone");
  assert.ok(Object.keys(before).length >= 8, `the fixture should touch many tables, got ${JSON.stringify(before)}`);

  const now = new Date("2026-11-13T10:00:00Z");
  await requestDeletion(db, "del-gone", now);
  // Other tests' requests may fall due at the same moment; what matters is that this one went.
  assert.ok((await purgeDueDeletions(db, storageFor, new Date(now.getTime() + GRACE_MS))).purged >= 1);

  assert.deepEqual(await leftovers("del-gone"), {}, "no row anywhere in cumulus_mail names the mailbox");
  const storage = storageFor("del-gone");
  for (const blob of [blobs.raw, blobs.file, blobs.shared]) {
    assert.equal(await storage.get(blob.blobId), null, "every blob is gone");
  }

  // The neighbour is untouched.
  assert.ok(Object.keys(await leftovers("del-neighbour")).length >= 8);
  const neighbourBlobs = await harness.db.query<{ raw_key: string }>(`select raw_key from cumulus_mail.messages where tenant_id = 'del-neighbour' and raw_key is not null`);
  assert.ok(await storageFor("del-neighbour").get(neighbourBlobs[0]!.raw_key), "the neighbour's blobs remain");
});

test("the audit record says it happened and holds no content and not the mailbox id", async () => {
  const { db, storageFor } = harness;
  await populate("del-audit");
  const now = new Date("2026-11-13T10:00:00Z");
  await requestDeletion(db, "del-audit", now);
  const report = await purgeMailbox(db, storageFor("del-audit"), "del-audit", new Date(now.getTime() + GRACE_MS));
  assert.ok(report.rows >= 8);
  assert.equal(report.blobs, 3);
  const audit = await db.query<Record<string, unknown>>(`select * from cumulus_mail.deletion_audit where subject_hmac = $1`, [subjectHmac("del-audit")]);
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.rows_deleted, report.rows);
  assert.equal(audit[0]!.blobs_deleted, 3);
  const text = JSON.stringify(audit[0]);
  assert.equal(/del-audit|cumuluscloud|Subject|Body of|leah|example\.com/.test(text), false, `no content or id: ${text}`);
});

test("purging is safe to run again (a retry after a partial failure)", async () => {
  const { db, storageFor } = harness;
  await populate("del-twice");
  await purgeMailbox(db, storageFor("del-twice"), "del-twice");
  const again = await purgeMailbox(db, storageFor("del-twice"), "del-twice");
  assert.deepEqual(again, { rows: 0, blobs: 0 });
  assert.deepEqual(await leftovers("del-twice"), {});
});

test("tables added later are found from the schema, so they are deleted too", async () => {
  const { db } = harness;
  await db.query(`create table if not exists cumulus_mail.future_feature (tenant_id text not null, note text)`);
  await populate("del-future");
  await db.query(`insert into cumulus_mail.future_feature (tenant_id, note) values ('del-future', 'later data')`);
  assert.ok((await tenantTables(db)).some((t) => t.table === "future_feature"));
  await purgeMailbox(db, harness.storageFor("del-future"), "del-future");
  assert.deepEqual(await leftovers("del-future"), {});
  await db.query(`drop table cumulus_mail.future_feature`);
});
