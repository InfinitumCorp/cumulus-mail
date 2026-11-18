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

test("saving a mailbox leaves out a new alias that takes a system address or a possible username; valid ones stay", async () => {
  const { createHarness, profile } = await import("./test-support.ts");
  const { openMailbox, writeSnapshot } = await import("./mailbox.ts");
  const harness = await createHarness();
  try {
    const { db, storageFor } = harness;
    const ada = profile("al-ada", "ada.al@cumuluscloud.app", "Ada");
    await openMailbox(db, "al-ada", ada);
    const base = { me: ada, messages: [], briefs: {}, tasks: [], contacts: [], signature: "", rules: [] };
    // Refused addresses are left out (the save itself goes through, so one bad alias can't block later edits).
    const saved = await writeSnapshot(db, storageFor, "al-ada", { ...base, aliases: ["security@cumuluscloud.app", "bob@cumuluscloud.app", "ada.al.smith@cumuluscloud.app", "x@not-verified.example", "ada.al+shop@cumuluscloud.app"] });
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
