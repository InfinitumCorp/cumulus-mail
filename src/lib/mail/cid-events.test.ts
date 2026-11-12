import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createHarness } from "./test-support.ts";
import { handleCidEvent, noticeFor, parseCidEvent, tenantForCid, verifyCidEventSignature, type CidEvent } from "./cid-events.ts";
import { findTenantByAddress } from "./directory.ts";
import { readSnapshot } from "./records.ts";

let harness: Awaited<ReturnType<typeof createHarness>>;
before(async () => {
  harness = await createHarness();
  // The Better Auth tables (copied into migrations/ when sign-in is on in an app).
  const { readFileSync } = await import("node:fs");
  for (const stmt of readFileSync(new URL("../../../migrations/auth/0001_auth.sql", import.meta.url), "utf8").split(/;\s*\n/)) {
    if (stmt.trim()) await harness.db.query(stmt);
  }
});
after(async () => { await harness.close(); });

const CID = "cid_7c1e9a2b-3d4f-4a5b-8c6d-7e8f9a0b1c2d";
const at = new Date().toISOString();

async function sign(secret: string, body: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `sha256=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

test("signature: valid, wrong secret, tampered body, malformed header", async () => {
  const body = JSON.stringify({ cid: CID, type: "account.created", detail: {}, at });
  const sig = await sign("s3cret", body);
  assert.equal(await verifyCidEventSignature("s3cret", body, sig), true);
  assert.equal(await verifyCidEventSignature("other", body, sig), false);
  assert.equal(await verifyCidEventSignature("s3cret", body + " ", sig), false);
  assert.equal(await verifyCidEventSignature("s3cret", body, "sha256=zz"), false);
  assert.equal(await verifyCidEventSignature("s3cret", body, null), false);
  assert.equal(await verifyCidEventSignature("", body, sig), false);
});

test("parse refuses bad cids, types and dates", () => {
  assert.equal(parseCidEvent("nope"), null);
  assert.equal(parseCidEvent(JSON.stringify({ cid: "x", type: "account.created", at })), null);
  assert.equal(parseCidEvent(JSON.stringify({ cid: CID, type: "DROP TABLE", at })), null);
  assert.equal(parseCidEvent(JSON.stringify({ cid: CID, type: "session.created", at: "never" })), null);
  assert.ok(parseCidEvent(JSON.stringify({ cid: CID, type: "session.created", detail: { device: "Safari on iOS" }, at })));
});

test("account.created provisions the mailbox and publishes the address before Mail is opened", async () => {
  const e: CidEvent = { cid: CID, type: "account.created", detail: { username: "robin", mailAddress: "robin@cumuluscloud.app" }, at };
  assert.equal(await handleCidEvent(harness.db, e, "cumuluscloud.app"), "provisioned");
  const tenant = await tenantForCid(harness.db, CID);
  assert.ok(tenant && tenant !== CID, "the tenant is Mail's own user id, as for a signed-in session");
  assert.equal(await findTenantByAddress(harness.db, "robin@cumuluscloud.app"), tenant);
  // The account row is what the later sign-in finds (providerId cumulus-id, accountId = cid).
  const acct = await harness.db.query<{ userId: string }>(`select "userId" from "account" where "accountId" = $1 and "providerId" = 'cumulus-id'`, [CID]);
  assert.equal(acct[0]?.userId, tenant);
  // Provisioning again (a retried event) reuses the same tenant.
  assert.equal(await handleCidEvent(harness.db, e, "cumuluscloud.app"), "provisioned");
  assert.equal(await tenantForCid(harness.db, CID), tenant);
  // Another domain is ignored.
  assert.equal(await handleCidEvent(harness.db, { ...e, cid: "cid_00000000-0000-4000-8000-000000000000", detail: { mailAddress: "x@evil.example" } }, "cumuluscloud.app"), "ignored");
});

test("security events land once in the inbox; none without a mailbox", async () => {
  const e: CidEvent = { cid: CID, type: "session.created", detail: { device: "Safari on iOS", country: "GB", method: "passkey" }, at };
  assert.equal(await handleCidEvent(harness.db, e, "cumuluscloud.app"), "notified");
  assert.equal(await handleCidEvent(harness.db, e, "cumuluscloud.app"), "duplicate");
  const snap = await readSnapshot(harness.db, (await tenantForCid(harness.db, CID))!);
  const notice = snap.messages.find((m) => m.subject === "New sign-in to your Cumulus://ID");
  assert.ok(notice);
  assert.equal(notice.folder, "inbox");
  assert.equal(notice.from.email, "security@cumuluscloud.app");
  assert.match(notice.body, /Safari on iOS in GB/);
  assert.ok(notice.labels.includes("Security"));
  assert.equal(await handleCidEvent(harness.db, { ...e, cid: "cid_11111111-1111-4111-8111-111111111111" }, "cumuluscloud.app"), "no-mailbox");
  assert.equal(await handleCidEvent(harness.db, { ...e, type: "profile.updated" }, "cumuluscloud.app"), "ignored");
});

test("every forwarded security event has a notice", () => {
  for (const type of ["session.created", "session.revoked_all", "passkey.added", "passkey.removed", "mfa.enabled", "mfa.disabled", "identity.linked", "identity.unlinked", "mail_key.published", "mail_key.revoked"]) {
    assert.ok(noticeFor({ cid: CID, type, detail: {}, at }), type);
  }
});

test("account.deleted stops routing the address; stored mail stays", async () => {
  const tenant = (await tenantForCid(harness.db, CID))!;
  assert.equal(await findTenantByAddress(harness.db, "robin@cumuluscloud.app"), tenant);
  const before = (await readSnapshot(harness.db, tenant)).messages.length;
  assert.equal(await handleCidEvent(harness.db, { cid: CID, type: "account.deleted", detail: { username: "robin" }, at }, "cumuluscloud.app"), "unrouted");
  assert.equal(await findTenantByAddress(harness.db, "robin@cumuluscloud.app"), null);
  assert.equal((await readSnapshot(harness.db, tenant)).messages.length, before);
});
