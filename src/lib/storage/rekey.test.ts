import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { openText, sealText, blindIndex } from "../mail/field-crypto.ts";
import { openMailbox } from "../mail/mailbox.ts";
import type { MailMessage } from "../mail/model.ts";
import { insertMessage, readSnapshot } from "../mail/records.ts";
import { createHarness, profile } from "../mail/test-support.ts";
import { openSeal } from "./crypto.ts";
import { keyringFromEnv, sealedKeyId } from "./keyring.ts";
import { notYetCurrent, rekey } from "./rekey.ts";

// test-support sets MAIL_BLOB_KEY to "ab"*32 when unset: today's single key, which becomes key 0.
const OLD = process.env.MAIL_BLOB_KEY ?? "ab".repeat(32);
const NEW = "cd".repeat(32);
const both = () => keyringFromEnv({ MAIL_BLOB_KEYS: `1:${NEW},0:${OLD}` });
const newOnly = () => keyringFromEnv({ MAIL_BLOB_KEYS: `1:${NEW}` });

let harness: Awaited<ReturnType<typeof createHarness>>;
before(async () => {
  harness = await createHarness();
});
after(async () => {
  await harness.close();
});

const message = (id: string): MailMessage => ({
  id,
  threadId: id,
  folder: "inbox",
  from: { name: "Leah", email: "leah@cumuluscloud.app" },
  to: [{ name: "Alex", email: "alex@cumuluscloud.app" }],
  cc: [],
  subject: `Subject ${id}`,
  body: `Body ${id}`,
  at: "2026-11-10T09:30:00.000Z",
  unread: true,
  starred: false,
  labels: [],
});

/** A mailbox written the way production writes today: v1, under MAIL_BLOB_KEY alone. */
async function legacyMailbox(tenant: string) {
  const { db, storageFor } = harness;
  await openMailbox(db, tenant, profile(tenant, `${tenant}@cumuluscloud.app`, tenant));
  const raw = await storageFor(tenant).put(new TextEncoder().encode(`raw mail for ${tenant}`));
  await insertMessage(db, tenant, message(`${tenant}-m1`), raw.blobId);
  await insertMessage(db, tenant, message(`${tenant}-m2`), null);
  return { blobId: raw.blobId };
}

const fieldKeyIds = async (tenant: string) => {
  const rows = await harness.db.query<{ subject: string }>(`select subject from cumulus_mail.messages where tenant_id = $1`, [tenant]);
  return rows.map((r) => sealedKeyId(new Uint8Array(Buffer.from(r.subject.slice(4), "base64url"))));
};

test("today, with MAIL_BLOB_KEY alone, values are still written in the v1 layout (rollback-safe)", async () => {
  await legacyMailbox("rk-v1");
  assert.deepEqual(await fieldKeyIds("rk-v1"), [0, 0]);
  assert.match(sealText("t", "x"), /^cm1\./);
  assert.equal(new Uint8Array(Buffer.from(sealText("t", "x").slice(4), "base64url"))[0], 1, "v1 layout byte");
});

test("a dry run counts by key and changes nothing", async () => {
  const { blobId } = await legacyMailbox("rk-dry");
  const report = await rekey(harness.db, harness.driver, both(), { fromTenant: "rk-dr" });
  assert.equal(report.applied, false);
  assert.ok(report.fields.scanned > 0);
  assert.ok((report.fields.byKey["0"] ?? 0) > 0);
  assert.equal(report.fields.resealed, 0);
  assert.equal(report.blobs.resealed, 0);
  assert.deepEqual(await fieldKeyIds("rk-dry"), [0, 0], "fields untouched");
  assert.equal(sealedKeyId(await harness.driver.get("rk-dry", blobId)), 0, "blob untouched");
  assert.ok(notYetCurrent(report) > 0);
});

test("apply moves every field and blob to the current key; mixed data reads throughout", async () => {
  const { blobId } = await legacyMailbox("rk-apply");
  const report = await rekey(harness.db, harness.driver, both(), { apply: true });
  assert.ok(report.fields.resealed > 0);
  assert.ok(report.blobs.resealed > 0);
  assert.equal(notYetCurrent(report), 0);
  assert.deepEqual(await fieldKeyIds("rk-apply"), [1, 1]);
  assert.equal(sealedKeyId(await harness.driver.get("rk-apply", blobId)), 1);
  // Readable with the new key alone: the snapshot decrypts, the blob opens.
  const ring = newOnly();
  const rows = await harness.db.query<{ subject: string }>(`select subject from cumulus_mail.messages where tenant_id = 'rk-apply' order by id`);
  assert.deepEqual(rows.map((r) => openText("rk-apply", r.subject, ring)), ["Subject rk-apply-m1", "Subject rk-apply-m2"]);
  assert.equal(new TextDecoder().decode(openSeal(ring, "rk-apply", await harness.driver.get("rk-apply", blobId))), "raw mail for rk-apply");
});

test("re-running changes nothing (idempotent), so a stopped run can simply be started again", async () => {
  await legacyMailbox("rk-twice");
  await rekey(harness.db, harness.driver, both(), { apply: true });
  const again = await rekey(harness.db, harness.driver, both(), { apply: true });
  assert.equal(again.fields.resealed, 0);
  assert.equal(again.blobs.resealed, 0);
  assert.equal(notYetCurrent(again), 0);
});

test("fromTenant resumes after a mailbox, in id order and in batches, with progress", async () => {
  await legacyMailbox("rk-z1");
  await legacyMailbox("rk-z2");
  const progress: string[] = [];
  const report = await rekey(harness.db, harness.driver, both(), {
    fromTenant: "rk-z1",
    batchSize: 1,
    onProgress: (r) => progress.push(r.lastTenant ?? ""),
  });
  assert.equal(report.lastTenant, "rk-z2");
  assert.ok(!progress.includes("rk-z1"), "the mailbox it resumed after is not redone");
  assert.ok(progress.length >= 1, "progress is reported per batch");
});

test("with the old key removed, anything not re-keyed is unreadable and reported, not crashed on", async () => {
  await legacyMailbox("rk-stale");
  const report = await rekey(harness.db, harness.driver, newOnly(), { apply: true, fromTenant: "rk-sta" });
  assert.ok(report.fields.failed > 0, "values under the missing key are counted as failed");
  assert.ok(report.blobs.failed > 0);
  const rows = await harness.db.query<{ subject: string }>(`select subject from cumulus_mail.messages where tenant_id = 'rk-stale'`);
  assert.throws(() => openText("rk-stale", rows[0]!.subject, newOnly()), /key 0, which is not in MAIL_BLOB_KEYS/);
});

test("blind indexes do not change with the keyring: lookups keep working after a rotation", () => {
  const before = blindIndex("rk-blind", "alias", "leah@cumuluscloud.app");
  const saved = process.env.MAIL_BLOB_KEYS;
  process.env.MAIL_BLOB_KEYS = `1:${NEW},0:${OLD}`;
  try {
    assert.equal(blindIndex("rk-blind", "alias", "leah@cumuluscloud.app"), before);
  } finally {
    if (saved === undefined) delete process.env.MAIL_BLOB_KEYS;
    else process.env.MAIL_BLOB_KEYS = saved;
  }
});

test("the app reads a re-keyed mailbox when deployed with MAIL_BLOB_KEYS", async () => {
  await legacyMailbox("rk-app");
  await rekey(harness.db, harness.driver, both(), { apply: true, fromTenant: "rk-ap" });
  const saved = process.env.MAIL_BLOB_KEYS;
  process.env.MAIL_BLOB_KEYS = `1:${NEW}`;
  try {
    const snapshot = await readSnapshot(harness.db, "rk-app");
    assert.deepEqual(snapshot.messages.map((m) => m.subject).sort(), ["Subject rk-app-m1", "Subject rk-app-m2"]);
    // New writes use the current key.
    assert.equal(sealedKeyId(new Uint8Array(Buffer.from(sealText("rk-app", "new").slice(4), "base64url"))), 1);
  } finally {
    if (saved === undefined) delete process.env.MAIL_BLOB_KEYS;
    else process.env.MAIL_BLOB_KEYS = saved;
  }
});
