import assert from "node:assert/strict";
import { test } from "node:test";
import { masterKeyFromEnv } from "../storage/crypto.ts";
import { createHarness } from "./test-support.ts";
import { authorizeShare, issueBlobShare, issueShareToken, memoryLedger, openBlobShare, readShareToken } from "./share.ts";

if (!process.env.MAIL_BLOB_KEY) process.env.MAIL_BLOB_KEY = "ef".repeat(32);

const key = masterKeyFromEnv();
const blobId = "ab".repeat(16);

test("share tokens expire, reject tampering, and stay bound to one tenant", async () => {
  const ledger = memoryLedger();
  const issued = issueShareToken(key, {
    tenantId: "tenant-a",
    blobId,
    exp: Date.now() + 60_000,
  });
  await ledger.issue(issued.claims);
  const ok = await authorizeShare(key, ledger, issued.token, { tenantId: "tenant-a", blobId });
  assert.equal(ok.jti, issued.claims.jti);

  const expired = issueShareToken(key, { tenantId: "tenant-a", blobId, exp: Date.now() - 1000 });
  await ledger.issue(expired.claims);
  await assert.rejects(() => authorizeShare(key, ledger, expired.token, { tenantId: "tenant-a", blobId }), /expired/);

  const [payload, mac] = issued.token.split(".");
  const flipped = `${payload}.${mac.slice(0, -1)}${mac.endsWith("A") ? "B" : "A"}`;
  assert.throws(() => readShareToken(key, flipped), /signature/);

  await assert.rejects(
    () => authorizeShare(key, ledger, issued.token, { tenantId: "tenant-b", blobId }),
    /different object/,
  );
  await ledger.revoke(issued.claims.jti, "tenant-a");
  await assert.rejects(() => authorizeShare(key, ledger, issued.token, { tenantId: "tenant-a", blobId }), /revoked/);
});

test("a share link opens only the tenant blob it was issued for", async () => {
  const harness = await createHarness();
  try {
    const plain = new TextEncoder().encode("shared forecast");
    const saved = await harness.storageFor("tenant-a").put(plain);
    await harness.storageFor("tenant-b").put(new TextEncoder().encode("other tenant"));
    await harness.db.query(
      `insert into cumulus_mail.mailboxes (tenant_id, address, display_name, cid, plan, quota_gb)
       values ($1, $2, $3, $4, $5, $6), ($7, $8, $9, $10, $11, $12)`,
      [
        "tenant-a", "a@cumuluscloud.app", "Ada", "cid:a", "Free", 15,
        "tenant-b", "b@cumuluscloud.app", "Bea", "cid:b", "Free", 15,
      ],
    );
    await harness.db.query(
      `insert into cumulus_mail.messages (
         tenant_id, id, thread_id, folder, from_name, from_email, to_json, cc_json, subject, body,
         sent_at, unread, starred, labels_json
       ) values ($1, $2, $2, 'inbox', 'Ada', 'a@cumuluscloud.app', '[]', '[]', 'Share', '', $3, false, false, '[]')`,
      ["tenant-a", "m-share", "2026-11-07T00:00:00.000Z"],
    );
    await harness.db.query(
      `insert into cumulus_mail.attachments (tenant_id, id, message_id, name, size, content_type, sha256, object_key)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      ["tenant-a", "att-1", "m-share", "note.txt", plain.byteLength, "text/plain", saved.sha256, saved.blobId],
    );
    const link = await issueBlobShare(harness.db, "tenant-a", saved.blobId, 60_000, key);
    const opened = await openBlobShare(
      harness.db,
      async (tenantId, id) => (await harness.storageFor(tenantId).get(id))?.body ?? null,
      link.token,
      key,
    );
    assert.equal(opened.tenantId, "tenant-a");
    assert.equal(Buffer.from(opened.body).toString(), "shared forecast");
    assert.equal(await harness.storageFor("tenant-b").get(saved.blobId), null);
    const [payload, mac] = link.token.split(".");
    const flipped = `${payload}.${mac.slice(0, -1)}${mac.endsWith("A") ? "B" : "A"}`;
    await assert.rejects(
      () => openBlobShare(harness.db, async () => plain, flipped, key),
      /signature/,
    );
  } finally {
    await harness.close();
  }
});
