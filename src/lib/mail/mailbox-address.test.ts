import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chooseMailboxAddress, localPartFrom } from "./mailbox-address.ts";
import { openMailbox } from "./mailbox.ts";
import { createHarness, profile } from "./test-support.ts";

let harness: Awaited<ReturnType<typeof createHarness>>;
before(async () => {
  harness = await createHarness();
});
after(async () => {
  await harness.close();
});

test("the local part comes from the sign-in email, cleaned, with reserved names refused", () => {
  assert.equal(localPartFrom("Ada.Lovelace+news@gmail.com"), "ada.lovelace");
  assert.equal(localPartFrom("j..o__e-@example.com"), "j.o.e");
  assert.equal(localPartFrom("Jöhn Smith@example.com"), "jhnsmith");
  assert.equal(localPartFrom("ab@example.com"), "");
  assert.equal(localPartFrom("postmaster@gmail.com"), "");
  assert.equal(localPartFrom("Admin@company.example"), "");
  assert.equal(localPartFrom(null), "");
  assert.equal(localPartFrom("x".repeat(80) + "@gmail.com").length, 40);
});

test("a new mailbox gets a free address on the mail domain, never the Google address", async () => {
  const db = harness.db;
  const domain = "cumuluscloud.app";
  assert.equal(await chooseMailboxAddress(db, "g-ada", "ada.lovelace@gmail.com", domain), "ada.lovelace@cumuluscloud.app");

  // Someone else already has it: the next free number.
  await openMailbox(db, "g-first", profile("g-first", "grace@cumuluscloud.app", "Grace"));
  assert.equal(await chooseMailboxAddress(db, "g-second", "grace@gmail.com", domain), "grace2@cumuluscloud.app");
  await openMailbox(db, "g-second", profile("g-second", "grace2@cumuluscloud.app", "Grace H"));
  assert.equal(await chooseMailboxAddress(db, "g-third", "Grace@company.example", domain), "grace3@cumuluscloud.app");

  // The tenant's own address is not "taken" from its own point of view.
  assert.equal(await chooseMailboxAddress(db, "g-first", "grace@gmail.com", domain), "grace@cumuluscloud.app");

  // Nothing usable in the sign-in email: an address from the tenant id.
  assert.equal(await chooseMailboxAddress(db, "Tenant_ABC-123", "ab@gmail.com", domain), "utenantabc123@cumuluscloud.app");
  assert.equal(await chooseMailboxAddress(db, "t-xyz", null, domain), "utxyz@cumuluscloud.app");
});
