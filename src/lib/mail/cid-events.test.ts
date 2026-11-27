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

test("account.created names the Mail user with the display name the person chose, when the issuer sends it", async () => {
  const cid = "cid_22222222-2222-4222-8222-222222222222";
  const e: CidEvent = { cid, type: "account.created", detail: { username: "robin2", displayName: "Robin Hood", mailAddress: "robin2@cumuluscloud.app" }, at };
  assert.equal(await handleCidEvent(harness.db, e, "cumuluscloud.app"), "provisioned");
  const tenant = await tenantForCid(harness.db, cid);
  const user = await harness.db.query<{ name: string }>(`select "name" from "user" where "id" = $1`, [tenant]);
  assert.equal(user[0]?.name, "Robin Hood");
});

test("security events land once in the inbox; none without a mailbox", async () => {
  const e: CidEvent = { cid: CID, type: "session.created", detail: { device: "Safari on iOS", country: "GB", method: "password+pin" }, at };
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
  for (const type of ["session.created", "session.revoked_all", "password.changed", "pin.set", "pin.changed", "signin.paused", "passkey.added", "passkey.removed", "mfa.enabled", "mfa.disabled", "identity.linked", "identity.unlinked", "mail_key.published", "mail_key.revoked"]) {
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

test("a paused PIN sign-in tells the owner their password is known", () => {
  const n = noticeFor({ cid: "cid_x", type: "signin.paused", detail: { path: "pin", failures: 10 }, at: "2026-11-12T00:00:00.000Z" })!;
  assert.match(n.body, /10 wrong PINs/);
  assert.match(n.body, /change it now/);
});

test("the daily PIN cap says 24 hours, and that a recovery code still works", () => {
  const n = noticeFor({ cid: "cid_x", type: "signin.paused", detail: { path: "pin-day", failures: 30 }, at: "2026-11-12T00:00:00.000Z" })!;
  assert.match(n.body, /30 wrong PINs/);
  assert.match(n.body, /24 hours \(a recovery code still signs in\)/);
  assert.match(n.body, /change it now/);
  assert.doesNotMatch(noticeFor({ cid: "cid_x", type: "signin.paused", detail: { path: "pin", failures: 10 }, at: "2026-11-12T00:00:00.000Z" })!.body, /24 hours/);
});

test("profile.updated renames the mailbox only while it still shows the previous name", async () => {
  const { sealText } = await import("./field-crypto.ts");
  const { writeSnapshot } = await import("./mailbox.ts");
  const cid = "cid_33333333-3333-4333-8333-333333333333";
  const created: CidEvent = { cid, type: "account.created", detail: { username: "maid", displayName: "Marian", mailAddress: "maid@cumuluscloud.app" }, at };
  assert.equal(await handleCidEvent(harness.db, created, "cumuluscloud.app"), "provisioned");
  const tenant = (await tenantForCid(harness.db, cid))!;
  const name = async () => (await readSnapshot(harness.db, tenant)).me.name;
  const t = (s: number) => new Date(Date.parse(at) + s * 1000).toISOString();
  const renamed = (displayName: string, previous: string, when: string): CidEvent => ({ cid, type: "profile.updated", detail: { displayName, previous }, at: when });
  assert.equal(await name(), "Marian");
  const tab = await readSnapshot(harness.db, tenant); // a tab opened before the rename
  assert.equal(await handleCidEvent(harness.db, renamed("Maid Marian", "Marian", t(10)), "cumuluscloud.app"), "renamed");
  assert.equal(await name(), "Maid Marian");
  // That tab's next full save still says "Marian": the rename stays.
  await writeSnapshot(harness.db, harness.storageFor, tenant, { ...tab, signature: "from the old tab" });
  assert.equal(await name(), "Maid Marian");

  // Out of order: B→C arrives, then the older A→B retry; Mail ends on C.
  assert.equal(await handleCidEvent(harness.db, renamed("Marian F.", "Maid Marian", t(30)), "cumuluscloud.app"), "renamed");
  assert.equal(await handleCidEvent(harness.db, renamed("Maid Marian", "Marian", t(10)), "cumuluscloud.app"), "ignored");
  assert.equal(await name(), "Marian F.");

  // A name chosen in Mail itself stays the person's choice.
  await harness.db.query(`update cumulus_mail.mailboxes set display_name = $2 where tenant_id = $1`, [tenant, sealText(tenant, "Lady Marian")]);
  assert.equal(await handleCidEvent(harness.db, renamed("M. Fitzwalter", "Marian F.", t(40)), "cumuluscloud.app"), "ignored");
  assert.equal(await name(), "Lady Marian");
  // Header-breaking characters never get in.
  await harness.db.query(`update cumulus_mail.mailboxes set display_name = $2 where tenant_id = $1`, [tenant, sealText(tenant, "Old")]);
  assert.equal(await handleCidEvent(harness.db, renamed('Eve <eve@evil.example>\r\nBcc: x', "Old", t(50)), "cumuluscloud.app"), "renamed");
  assert.doesNotMatch(await name(), /[<>\r\n"]/);
  // Someone without Mail: nothing to do, and answered as done (no retries for an hour).
  assert.equal(await handleCidEvent(harness.db, { ...renamed("X", "Y", t(60)), cid: "cid_44444444-4444-4444-8444-444444444444" }, "cumuluscloud.app"), "ignored");
});

test("after account.deleted, opening, saving or a domain check never routes the address again; Mail's sessions end", async () => {
  const { openMailbox, writeSnapshot } = await import("./mailbox.ts");
  const { publishRoutes, readRouteState } = await import("./records.ts");
  const cid = "cid_55555555-5555-4555-8555-555555555555";
  assert.equal(await handleCidEvent(harness.db, { cid, type: "account.created", detail: { username: "gone", displayName: "Gone", mailAddress: "gone@cumuluscloud.app" }, at }, "cumuluscloud.app"), "provisioned");
  const tenant = (await tenantForCid(harness.db, cid))!;
  await harness.db.query(`insert into "session" ("id", "expiresAt", "token", "updatedAt", "userId") values ('s-gone', now() + interval '1 day', 'tok-gone', now(), $1)`, [tenant]);
  assert.equal(await findTenantByAddress(harness.db, "gone@cumuluscloud.app"), tenant);

  assert.equal(await handleCidEvent(harness.db, { cid, type: "account.deleted", detail: {}, at }, "cumuluscloud.app"), "unrouted");
  assert.equal(await findTenantByAddress(harness.db, "gone@cumuluscloud.app"), null);
  assert.equal((await harness.db.query(`select 1 from "session" where "userId" = $1`, [tenant])).length, 0, "Mail sign-in ended");

  // A tab or token still around afterwards: open, save, domain check.
  const profile = (await readSnapshot(harness.db, tenant)).me;
  await openMailbox(harness.db, tenant, profile);
  const snap = await readSnapshot(harness.db, tenant);
  await writeSnapshot(harness.db, harness.storageFor, tenant, { ...snap, settings: { ...snap.settings!, closedAt: undefined } });
  await publishRoutes(harness.db, tenant, (await readRouteState(harness.db, tenant))!);
  assert.equal(await findTenantByAddress(harness.db, "gone@cumuluscloud.app"), null, "still unrouted");
  assert.equal((await readSnapshot(harness.db, tenant)).settings?.closedAt, new Date(at).toISOString(), "a client can't clear it");
});
