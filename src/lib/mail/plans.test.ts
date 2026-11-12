import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { openMailbox, writeSnapshot } from "./mailbox.ts";
import { MAX_ALIASES } from "./model.ts";
import { DEFAULT_PLAN, isPlanId, limitsFor, maxLimit, PLANS } from "./plans.ts";
import { readProfile, readSettings, readSnapshot, writeSettings } from "./records.ts";
import { defaultSettings, MAX_DOMAINS } from "./settings.ts";
import { MAX_FOLDERS } from "./folders.ts";
import { createHarness, profile } from "./test-support.ts";

test("the default plan's limits are exactly the limits before plans existed", () => {
  assert.equal(DEFAULT_PLAN, "plus");
  const plus = PLANS.plus;
  assert.deepEqual([plus.quotaGb, plus.aliases, plus.domains, plus.folders, plus.messages], [15, 15, 3, 50, 5000]);
  assert.equal(MAX_ALIASES, 15);
  assert.equal(MAX_DOMAINS, 3);
  assert.equal(MAX_FOLDERS, maxLimit("folders"));
  assert.equal(maxLimit("domains"), 10);
});

test("unknown plans fall back to the default; canceled falls back to Free", () => {
  assert.equal(isPlanId("pro"), true);
  assert.equal(isPlanId("enterprise"), false);
  assert.deepEqual(limitsFor("enterprise"), PLANS.plus);
  assert.deepEqual(limitsFor(undefined), PLANS.plus);
  assert.deepEqual(limitsFor("pro", "past_due"), PLANS.pro);
  assert.deepEqual(limitsFor("pro", "canceled"), PLANS.free);
});

let harness: Awaited<ReturnType<typeof createHarness>>;
before(async () => {
  harness = await createHarness();
});
after(async () => {
  await harness.close();
});

const domain = (name: string) => ({ domain: name, catchAll: true, verified: true, txtName: "", txtValue: "" });

test("every mailbox starts on Plus, and the server enforces the mailbox's own plan", async () => {
  const { db, storageFor } = harness;
  const me = profile("plan-a", "plan.a@cumuluscloud.app", "Pat");
  await openMailbox(db, "plan-a", me);
  assert.deepEqual((await readSnapshot(db, "plan-a")).me.limits, PLANS.plus);
  assert.deepEqual((await readProfile(db, "plan-a"))?.limits, PLANS.plus);

  // On Plus: two addresses, one custom domain with a catch-all, all accepted and routed.
  const base = await readSnapshot(db, "plan-a");
  await writeSnapshot(db, storageFor, "plan-a", {
    ...base,
    aliases: ["pat.one@cumuluscloud.app", "pat.two@cumuluscloud.app"],
    settings: { ...defaultSettings(), domains: [domain("pat.example")] },
  });
  // Verify the domain the way the DNS check does (only the server can set verified), then save again.
  const stored = await readSettings(db, "plan-a");
  await writeSettings(db, "plan-a", { ...stored, domains: stored.domains.map((item) => ({ ...item, verified: true })) });
  await writeSnapshot(db, storageFor, "plan-a", await readSnapshot(db, "plan-a"));
  const routedDomains = async (tenant: string) =>
    (await db.query<{ domain: string }>(`select distinct domain from cumulus_mail.address_routes where tenant_id = $1`, [tenant])).map((row) => row.domain);
  assert.ok((await routedDomains("plan-a")).includes("pat.example"));

  // Move the mailbox to Free (as billing would). Limits shrink; existing addresses are kept but not added to.
  await db.query(`update cumulus_mail.mailboxes set plan_id = 'free' where tenant_id = $1`, ["plan-a"]);
  const free = await readSnapshot(db, "plan-a");
  assert.deepEqual(free.me.limits, PLANS.free);
  await assert.rejects(() => writeSnapshot(db, storageFor, "plan-a", free), /up to 0 custom domains/);
  // Without the domain the save goes through (both existing addresses kept), and the catch-all route goes.
  const kept = await writeSnapshot(db, storageFor, "plan-a", { ...free, settings: { ...free.settings!, domains: [] } });
  assert.equal(kept.aliases.length, 2);
  await assert.rejects(
    () => writeSnapshot(db, storageFor, "plan-a", { ...kept, aliases: [...kept.aliases, "pat.three@cumuluscloud.app"] }),
    /up to 1 addresses/,
  );
  assert.equal((await routedDomains("plan-a")).includes("pat.example"), false);

  // Folders: Free allows 10.
  const folders = Array.from({ length: 11 }, (_, index) => ({ id: `folder-f${index}` as const, name: `F${index}` }));
  await assert.rejects(
    () => writeSnapshot(db, storageFor, "plan-a", { ...kept, settings: { ...kept.settings!, folders } }),
    /up to 10 folders/,
  );
});

test("a plan without catch-all keeps the domain but does not route its catch-all", async () => {
  const { db, storageFor } = harness;
  const me = profile("plan-b", "plan.b@cumuluscloud.app", "Bo");
  await openMailbox(db, "plan-b", me);
  // A canceled subscription falls back to Free, which has no catch-all. Free also allows no custom
  // domains, so this test lets Free hold one domain (restored below) to see the catch-all rule alone.
  const original = PLANS.free.domains;
  (PLANS.free as { domains: number }).domains = 1;
  try {
    await db.query(`update cumulus_mail.mailboxes set plan_id = 'pro', plan_status = 'canceled' where tenant_id = $1`, ["plan-b"]);
    const box = await readSnapshot(db, "plan-b");
    assert.equal(box.me.limits?.catchAll, false);
    await writeSnapshot(db, storageFor, "plan-b", { ...box, settings: { ...defaultSettings(), domains: [domain("bo.example")] } });
    const stored = await readSettings(db, "plan-b");
    await writeSettings(db, "plan-b", { ...stored, domains: stored.domains.map((item) => ({ ...item, verified: true })) });
    const saved = await writeSnapshot(db, storageFor, "plan-b", await readSnapshot(db, "plan-b"));
    assert.equal(saved.settings?.domains[0]?.verified, true);
    assert.equal(saved.settings?.domains[0]?.catchAll, true);
    // The domain is kept and verified, but its catch-all is not routed on a plan without catch-all.
    const domains = (await db.query<{ domain: string }>(`select distinct domain from cumulus_mail.address_routes where tenant_id = $1`, ["plan-b"])).map((row) => row.domain);
    assert.equal(domains.includes("bo.example"), false);
  } finally {
    (PLANS.free as { domains: number }).domains = original;
  }
});
