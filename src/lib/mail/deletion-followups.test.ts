import assert from "node:assert/strict";
import { mkdtemp, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, before, test } from "node:test";
import { createFilesystemDriver } from "../storage/driver.ts";
import { deletionStripe, purgeMailbox, requestDeletion } from "./account-deletion.ts";
import type { StripeClient } from "./billing.ts";
import { referencedBlobs, sweepOrphanBlobs } from "./blob-sweeper.ts";
import { openMailbox } from "./mailbox.ts";
import { insertMessage } from "./records.ts";
import { createHarness, profile } from "./test-support.ts";

let harness: Awaited<ReturnType<typeof createHarness>>;
before(async () => {
  harness = await createHarness();
});
after(async () => {
  await harness.close();
});

const blob = (n: number) => n.toString(16).padStart(32, "0");
const old = new Date("2026-01-01T00:00:00Z");
const NOW = new Date("2026-11-13T12:00:00Z");

async function store(driver: ReturnType<typeof createFilesystemDriver>, root: string, tenant: string, id: string, when = old) {
  await driver.put(tenant, id, new TextEncoder().encode(`bytes ${id}`));
  await utimes(join(root, "tenants", tenant, id), when, when);
}

test("the sweeper reports orphans and deletes nothing by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "sweep-"));
  const driver = createFilesystemDriver(root);
  const { db } = harness;
  await openMailbox(db, "sweep-a", profile("sweep-a", "a@cumuluscloud.app"));
  await store(driver, root, "sweep-a", blob(1)); // referenced
  await store(driver, root, "sweep-a", blob(2)); // orphan
  await store(driver, root, "sweep-gone", blob(3)); // orphan of a mailbox that no longer exists
  await store(driver, root, "sweep-a", blob(4), new Date(NOW.getTime() - 60_000)); // orphan, but too new
  await store(driver, root, "probe", blob(5)); // health probe: never touched
  await insertMessage(db, "sweep-a", {
    id: "s1", threadId: "s1", folder: "inbox", from: { name: "x", email: "x@example.com" }, to: [], cc: [],
    subject: "s", body: "b", at: "2026-11-01T00:00:00Z", unread: false, starred: false, labels: [],
  }, blob(1));

  const dry = await sweepOrphanBlobs(db, driver, { now: NOW });
  assert.equal(dry.applied, false);
  assert.equal(dry.scanned, 5);
  assert.equal(dry.referenced, 1);
  assert.equal(dry.tooNew, 1);
  assert.deepEqual(dry.orphans.map((o) => `${o.tenantId}/${o.blobId}`).sort(), [`sweep-a/${blob(2)}`, `sweep-gone/${blob(3)}`]);
  assert.deepEqual(Object.keys(dry.byTenant).sort(), ["sweep-a", "sweep-gone"]);
  assert.equal(dry.deleted, 0);
  // Nothing was deleted.
  for (const [t, id] of [["sweep-a", blob(2)], ["sweep-gone", blob(3)]] as const) assert.ok(await driver.get(t, id));

  const applied = await sweepOrphanBlobs(db, driver, { now: NOW, apply: true });
  assert.equal(applied.deleted, 2);
  await assert.rejects(() => driver.get("sweep-a", blob(2)));
  await assert.rejects(() => driver.get("sweep-gone", blob(3)));
  assert.ok(await driver.get("sweep-a", blob(1)), "the referenced blob stays");
  assert.ok(await driver.get("sweep-a", blob(4)), "the new blob stays");
  assert.ok(await driver.get("probe", blob(5)), "the probe stays");
});

test("a driver that cannot list says so instead of guessing", async () => {
  const noList = { ...createFilesystemDriver("/tmp/none"), list: undefined };
  await assert.rejects(() => sweepOrphanBlobs(harness.db, noList), /cannot list blobs/);
});

test("referencedBlobs covers raw messages, attachments and shared blobs", async () => {
  const keys = await referencedBlobs(harness.db);
  assert.ok(keys.has(`sweep-a/${blob(1)}`));
});

test("the Stripe hook is off unless asked for, and off when billing is off", async () => {
  assert.equal(await deletionStripe({}), null);
  assert.equal(await deletionStripe({ MAIL_DELETE_STRIPE_CUSTOMER: "on" }), null, "billing off: skipped");
  assert.equal(await deletionStripe({ STRIPE_SECRET_KEY: "sk_test_x" }), null, "billing on, flag off: skipped");
  assert.equal(typeof (await deletionStripe({ MAIL_DELETE_STRIPE_CUSTOMER: "on", STRIPE_SECRET_KEY: "sk_test_x" })), "function");
});

test("with the hook on, the purge deletes the Stripe customer first; an already-gone customer is fine", async () => {
  const { db, storageFor } = harness;
  await openMailbox(db, "stripe-del", profile("stripe-del", "s@cumuluscloud.app"));
  await db.query(`update cumulus_mail.mailboxes set stripe_customer_id = 'cus_ABC123' where tenant_id = 'stripe-del'`);
  await requestDeletion(db, "stripe-del");
  const calls: string[] = [];
  const stripe: StripeClient = async (method, path) => {
    calls.push(`${method} ${path}`);
    return {};
  };
  const report = await purgeMailbox(db, storageFor("stripe-del"), "stripe-del", new Date(), { stripe });
  assert.deepEqual(calls, ["DELETE /v1/customers/cus_ABC123"]);
  assert.equal(report.stripeCustomer, "deleted");

  await openMailbox(db, "stripe-gone", profile("stripe-gone", "g@cumuluscloud.app"));
  await db.query(`update cumulus_mail.mailboxes set stripe_customer_id = 'cus_GONE' where tenant_id = 'stripe-gone'`);
  const missing: StripeClient = async () => {
    throw new Error("Stripe DELETE /v1/customers/cus_GONE failed: No such customer: 'cus_GONE'");
  };
  assert.equal((await purgeMailbox(db, storageFor("stripe-gone"), "stripe-gone", new Date(), { stripe: missing })).stripeCustomer, "deleted");
});

test("if Stripe fails for another reason, nothing is deleted and the purge can retry", async () => {
  const { db, storageFor } = harness;
  await openMailbox(db, "stripe-down", profile("stripe-down", "d@cumuluscloud.app"));
  await db.query(`update cumulus_mail.mailboxes set stripe_customer_id = 'cus_DOWN' where tenant_id = 'stripe-down'`);
  const down: StripeClient = async () => {
    throw new Error("Stripe DELETE /v1/customers/cus_DOWN failed: HTTP 503");
  };
  await assert.rejects(() => purgeMailbox(db, storageFor("stripe-down"), "stripe-down", new Date(), { stripe: down }), /503/);
  const still = await db.query(`select 1 from cumulus_mail.mailboxes where tenant_id = 'stripe-down'`);
  assert.equal(still.length, 1, "the mailbox and its customer id are still there for the retry");
});
