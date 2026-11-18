import assert from "node:assert/strict";
import { test } from "node:test";
import { aliasProblem, newAlias } from "./alias.ts";

const ME = "alex@cumuluscloud.app";
const D = "cumuluscloud.app";

test("aliases on the platform domain: Mail's random ones or ones starting with your own name", () => {
  for (let i = 0; i < 20; i++) assert.equal(aliasProblem(newAlias(Math.random, D), ME, [], D), null);
  for (const ok of ["alex.shop", "alex-news", "alex+x"]) assert.equal(aliasProblem(`${ok}@${D}`, ME, [], D), null, ok);
  // Someone else's (future) name, a system address, or a name that only begins like yours.
  for (const bad of ["bob", "security", "postmaster", "abuse", "alexander", "alex.", "north.quiet.12"]) {
    assert.match(aliasProblem(`${bad}@${D}`, ME, [], D) ?? "", /start with your name|isn't valid/, bad);
  }
});

test("aliases on other domains: only ones this mailbox verified", () => {
  assert.equal(aliasProblem("x@mine.example", ME, ["mine.example"], D), null);
  assert.match(aliasProblem("x@someone-else.example", ME, ["mine.example"], D) ?? "", /verify/);
});

test("saving a mailbox refuses a new alias that takes a system address or someone else's name; existing ones stay", async () => {
  const { createHarness, profile } = await import("./test-support.ts");
  const { openMailbox, writeSnapshot } = await import("./mailbox.ts");
  const harness = await createHarness();
  try {
    const { db, storageFor } = harness;
    const ada = profile("al-ada", "ada.al@cumuluscloud.app", "Ada");
    await openMailbox(db, "al-ada", ada);
    const base = { me: ada, messages: [], briefs: {}, tasks: [], contacts: [], signature: "", rules: [] };
    for (const bad of ["security@cumuluscloud.app", "bob@cumuluscloud.app", "x@not-verified.example"]) {
      await assert.rejects(writeSnapshot(db, storageFor, "al-ada", { ...base, aliases: [bad] }), /start with your name|verify/, bad);
    }
    const saved = await writeSnapshot(db, storageFor, "al-ada", { ...base, aliases: ["ada.al.shop@cumuluscloud.app"] });
    assert.deepEqual(saved.aliases, ["ada.al.shop@cumuluscloud.app"]);
  } finally {
    await harness.close();
  }
});
