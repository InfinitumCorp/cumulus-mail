import assert from "node:assert/strict";
import { test } from "node:test";
import { aliasProblem, newAlias } from "./alias.ts";

const ME = "alex@cumuluscloud.app";
const D = "cumuluscloud.app";

test("aliases on the platform domain: Mail's random ones, or your name + a word (never a possible username)", () => {
  for (let i = 0; i < 20; i++) assert.equal(aliasProblem(newAlias(Math.random, D), ME, [], D), null);
  for (const ok of ["alex+shop", "alex+news.letters", "alex+a_b"]) assert.equal(aliasProblem(`${ok}@${D}`, ME, [], D), null, ok);
  assert.equal(aliasProblem(`ada_b+x@${D}`, "ada_b@cumuluscloud.app", [], D), null, "usernames with _ work");
  // Anything a username could be (someone's future address), system addresses, or malformed ones.
  for (const bad of ["bob", "security", "postmaster", "alexander", "alex.smith", "alex-jones", "alex+", "alex..x", "alex.x.", "north.quiet.12"]) {
    assert.match(aliasProblem(`${bad}@${D}`, ME, [], D) ?? "", /a plus and a word|isn't valid/, bad);
  }
});

test("aliases on other domains: only ones this mailbox verified", () => {
  assert.equal(aliasProblem("x@mine.example", ME, ["mine.example"], D), null);
  assert.match(aliasProblem("x@someone-else.example", ME, ["mine.example"], D) ?? "", /verify/);
});

test("saving a mailbox refuses a new alias that takes a system address or a possible username; valid ones save", async () => {
  const { createHarness, profile } = await import("./test-support.ts");
  const { openMailbox, writeSnapshot } = await import("./mailbox.ts");
  const harness = await createHarness();
  try {
    const { db, storageFor } = harness;
    const ada = profile("al-ada", "ada.al@cumuluscloud.app", "Ada");
    await openMailbox(db, "al-ada", ada);
    const base = { me: ada, messages: [], briefs: {}, tasks: [], contacts: [], signature: "", rules: [] };
    for (const bad of ["security@cumuluscloud.app", "bob@cumuluscloud.app", "ada.al.smith@cumuluscloud.app", "x@not-verified.example"]) {
      await assert.rejects(writeSnapshot(db, storageFor, "al-ada", { ...base, aliases: [bad] }), /plus and a word|verify/, bad);
    }
    const saved = await writeSnapshot(db, storageFor, "al-ada", { ...base, aliases: ["ada.al+shop@cumuluscloud.app"] });
    assert.deepEqual(saved.aliases, ["ada.al+shop@cumuluscloud.app"]);
  } finally {
    await harness.close();
  }
});

test("a backup restore applies the same rule: no system addresses or other people's names come in", async () => {
  const { allowedAliases } = await import("./alias.ts");
  assert.deepEqual(allowedAliases(["security@cumuluscloud.app", "alex+old@cumuluscloud.app", "kept.one@cumuluscloud.app"], ["kept.one@cumuluscloud.app"], ME, [], D),
    ["alex+old@cumuluscloud.app", "kept.one@cumuluscloud.app"], "valid new ones and ones the mailbox already had");
});

test("a mailbox's own address beats another mailbox's route for it (a name taken before its Cumulus ID existed)", async () => {
  const { createHarness, profile } = await import("./test-support.ts");
  const { openMailbox, writeSnapshot } = await import("./mailbox.ts");
  const { readSnapshot } = await import("./records.ts");
  const { findTenantByAddress, publishAddress } = await import("./directory.ts");
  const harness = await createHarness();
  try {
    const { db, storageFor } = harness;
    await openMailbox(db, "sq-mallory", profile("sq-mallory", "mallory@cumuluscloud.app", "M"));
    // The rule refuses bob@ as an alias now; a route like this could only come from before it.
    await publishAddress(db, "sq-mallory", "bob@cumuluscloud.app");
    assert.equal(await findTenantByAddress(db, "bob@cumuluscloud.app"), "sq-mallory");
    // Bob's mailbox is made (account.created, or his first sign-in): the address is his.
    await openMailbox(db, "sq-bob", profile("sq-bob", "bob@cumuluscloud.app", "Bob"));
    assert.equal(await findTenantByAddress(db, "bob@cumuluscloud.app"), "sq-bob");
    // Saves on either side don't hand it back.
    await writeSnapshot(db, storageFor, "sq-mallory", { ...(await readSnapshot(db, "sq-mallory")), signature: "m" });
    await writeSnapshot(db, storageFor, "sq-bob", { ...(await readSnapshot(db, "sq-bob")), signature: "b" });
    assert.equal(await findTenantByAddress(db, "bob@cumuluscloud.app"), "sq-bob");
  } finally {
    await harness.close();
  }
});
