import assert from "node:assert/strict";
import { test } from "node:test";
import { ownershipTxt } from "./domain-ownership.ts";

test("the domain TXT record is bound to the mailbox: another mailbox can't verify with the same published record", () => {
  const a = ownershipTxt("tenant-a", "acme.example"), b = ownershipTxt("tenant-b", "acme.example");
  assert.equal(a.name, "_cumulus-mail.acme.example");
  assert.match(a.value, /^cumulus-mail-verify=[0-9a-f]{32}$/);
  assert.notEqual(a.value, b.value);
  assert.equal(ownershipTxt("tenant-a", "ACME.example").value, a.value, "stable and case-insensitive");
});

test("stored settings: client-sent TXT values are replaced; a domain verified under the old shared record is checked again", async () => {
  const { createHarness, profile } = await import("./test-support.ts");
  const { openMailbox } = await import("./mailbox.ts");
  const { readSettings, writeSettings } = await import("./records.ts");
  const { sealText } = await import("./field-crypto.ts");
  const harness = await createHarness();
  try {
    const { db } = harness;
    await openMailbox(db, "own-a", profile("own-a", "own.a@cumuluscloud.app", "A"));
    const base = await readSettings(db, "own-a");
    // Old-style row: verified with the shared value everyone used.
    const legacy = { ...base, domains: [{ domain: "acme.example", catchAll: false, verified: true, txtName: "_cumulus-mail.acme.example", txtValue: "cumulus-mail-verify=cumuluscloud.app" }] };
    await db.query(`update cumulus_mail.mailboxes set settings_enc = $2 where tenant_id = $1`, ["own-a", sealText("own-a", JSON.stringify(legacy))]);
    const read = await readSettings(db, "own-a");
    assert.equal(read.domains[0]?.verified, false, "checked again under its own record");
    assert.equal(read.domains[0]?.txtValue, ownershipTxt("own-a", "acme.example").value);
    // The server's check then marks it verified: it stays verified, bound to this mailbox.
    await writeSettings(db, "own-a", { ...read, domains: [{ ...read.domains[0]!, verified: true, txtValue: "forged" }] });
    const after = await readSettings(db, "own-a");
    assert.equal(after.domains[0]?.verified, true);
    assert.equal(after.domains[0]?.txtValue, ownershipTxt("own-a", "acme.example").value, "a client-sent value never sticks");
  } finally {
    await harness.close();
  }
});

test("an alias on a custom domain routes only while the mailbox has that domain verified", async () => {
  const { createHarness, profile } = await import("./test-support.ts");
  const { openMailbox, writeSnapshot } = await import("./mailbox.ts");
  const { readSettings, writeSettings, readSnapshot, routedAddresses } = await import("./records.ts");
  const { findTenantByAddress, replaceRoutedAddresses } = await import("./directory.ts");
  const harness = await createHarness();
  try {
    const { db, storageFor } = harness;
    await openMailbox(db, "rt-a", profile("rt-a", "rt.a@cumuluscloud.app", "A"));
    const settings = await readSettings(db, "rt-a");
    const domain = { domain: "acme.example", catchAll: true, verified: true, txtName: "_cumulus-mail.acme.example", txtValue: "" };
    await writeSettings(db, "rt-a", { ...settings, domains: [domain] });
    const snap = await readSnapshot(db, "rt-a");
    await writeSnapshot(db, storageFor, "rt-a", { ...snap, aliases: ["sales@acme.example", "rt.a+shop@cumuluscloud.app"] });
    assert.equal(await findTenantByAddress(db, "sales@acme.example"), "rt-a");
    assert.equal(await findTenantByAddress(db, "anyone@acme.example"), "rt-a", "catch-all");

    // The domain stops verifying (a re-check, as checkDomainForSession does): the alias stays saved but stops routing.
    await writeSettings(db, "rt-a", { ...(await readSettings(db, "rt-a")), domains: [{ ...domain, verified: false }] });
    const lapsed = await readSnapshot(db, "rt-a");
    assert.deepEqual(lapsed.aliases.sort(), ["rt.a+shop@cumuluscloud.app", "sales@acme.example"]);
    assert.deepEqual(routedAddresses(lapsed).sort(), ["rt.a+shop@cumuluscloud.app", "rt.a@cumuluscloud.app"]);
    await replaceRoutedAddresses(db, "rt-a", routedAddresses(lapsed));
    assert.equal(await findTenantByAddress(db, "sales@acme.example"), null);
    assert.equal(await findTenantByAddress(db, "anyone@acme.example"), null);
    assert.equal(await findTenantByAddress(db, "rt.a+shop@cumuluscloud.app"), "rt-a");

    // Verified again: it routes again, nothing re-added by hand.
    await writeSettings(db, "rt-a", { ...(await readSettings(db, "rt-a")), domains: [domain] });
    await replaceRoutedAddresses(db, "rt-a", routedAddresses(await readSnapshot(db, "rt-a")));
    assert.equal(await findTenantByAddress(db, "sales@acme.example"), "rt-a");
  } finally {
    await harness.close();
  }
});

test("a domain that changed hands: the old mailbox can still save, and verifying again doesn't take addresses back", async () => {
  const { createHarness, profile } = await import("./test-support.ts");
  const { openMailbox, writeSnapshot } = await import("./mailbox.ts");
  const { readSettings, writeSettings, readSnapshot, readRouteState, publishRoutes } = await import("./records.ts");
  const { findTenantByAddress } = await import("./directory.ts");
  const harness = await createHarness();
  try {
    const { db, storageFor } = harness;
    const domain = { domain: "acme.example", catchAll: true, verified: true, txtName: "_cumulus-mail.acme.example", txtValue: "" };
    const setDomain = async (tenant: string, d: typeof domain) => writeSettings(db, tenant, { ...(await readSettings(db, tenant)), domains: [d] });
    const republish = async (tenant: string) => publishRoutes(db, tenant, (await readRouteState(db, tenant))!);
    await openMailbox(db, "hand-a", profile("hand-a", "hand.a@cumuluscloud.app", "A"));
    await openMailbox(db, "hand-b", profile("hand-b", "hand.b@cumuluscloud.app", "B"));
    await setDomain("hand-a", domain);
    await writeSnapshot(db, storageFor, "hand-a", { ...(await readSnapshot(db, "hand-a")), aliases: ["sales@acme.example"] });

    // acme stops pointing at A (A's check unroutes it); B verifies it and takes sales@ and the catch-all.
    await setDomain("hand-a", { ...domain, verified: false });
    await republish("hand-a");
    await setDomain("hand-b", domain);
    await writeSnapshot(db, storageFor, "hand-b", { ...(await readSnapshot(db, "hand-b")), aliases: ["sales@acme.example"] });
    assert.equal(await findTenantByAddress(db, "sales@acme.example"), "hand-b");

    // A's next save still works; the lapsed alias that B now has is dropped.
    const a = await writeSnapshot(db, storageFor, "hand-a", { ...(await readSnapshot(db, "hand-a")), signature: "still saving" });
    assert.deepEqual(a.aliases, []);

    // Even if A verifies again (both records left in DNS), B keeps sales@ and the catch-all.
    await setDomain("hand-a", domain);
    await republish("hand-a");
    assert.equal(await findTenantByAddress(db, "sales@acme.example"), "hand-b");
    assert.equal(await findTenantByAddress(db, "anyone@acme.example"), "hand-b");
    const rows = await db.query<{ tenant_id: string }>(`select tenant_id from cumulus_mail.address_routes where domain = 'acme.example'`);
    assert.deepEqual(rows.map((r) => r.tenant_id).sort(), ["hand-b", "hand-b"]);
    assert.equal(await findTenantByAddress(db, "hand.a@cumuluscloud.app"), "hand-a");
  } finally {
    await harness.close();
  }
});
