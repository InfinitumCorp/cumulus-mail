import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ingestInboundEmail } from "./inbound.ts";
import { openMailbox } from "./mailbox.ts";
import type { MailAuth } from "./model.ts";
import { readSnapshot } from "./records.ts";
import {
  badReputation,
  dohResolver,
  inboundVerdict,
  listKind,
  MIN_REPORTS,
  messageSender,
  rblListed,
  rblZones,
  reportNotSpam,
  reportSpam,
  reputation,
  senderDomain,
  type ResolveA,
} from "./spam.ts";
import { createHarness, profile } from "./test-support.ts";

let harness: Awaited<ReturnType<typeof createHarness>>;
before(async () => {
  harness = await createHarness();
});
after(async () => {
  await harness.close();
});

const PASS: MailAuth = { spf: "pass", dkim: "pass", dmarc: "pass", policy: "none", disposition: "deliver" };
const NONE: MailAuth = { spf: "none", dkim: "none", dmarc: "none", policy: "none", disposition: "deliver" };
const DMARC_QUARANTINE: MailAuth = { spf: "fail", dkim: "fail", dmarc: "fail", policy: "quarantine", disposition: "quarantine" };

/** A fixture RBL: names in `listed` answer 127.0.1.2, `errors` answer the 127.255.255.254 error code. */
const fixtureRbl = (listed: string[], errors: string[] = []): ResolveA => async (name) => {
  if (listed.includes(name)) return ["127.0.1.2"];
  if (errors.includes(name)) return ["127.255.255.254"];
  throw Object.assign(new Error("NXDOMAIN"), { code: "ENOTFOUND" });
};

async function mailbox(id: string) {
  await openMailbox(harness.db, id, profile(id, `${id}@cumuluscloud.app`));
  return id;
}

test("senderDomain takes the domain of an address and refuses junk", () => {
  assert.equal(senderDomain("News@Shop.Example."), "shop.example");
  assert.equal(senderDomain("no-at-sign"), null);
  assert.equal(senderDomain("x@-bad-.example"), null);
});

test("clean mail goes to the Inbox and is counted for its domain", async () => {
  const tenant = await mailbox("spam-clean");
  assert.deepEqual(await inboundVerdict(harness.db, tenant, "hi@clean.example", PASS), { folder: "inbox", reason: "clean" });
  assert.equal((await reputation(harness.db, "clean.example")).received, 1);
});

test("Report spam blocks the sender for that mailbox only", async () => {
  const a = await mailbox("spam-a");
  const b = await mailbox("spam-b");
  await reportSpam(harness.db, a, "pest@pest.example");
  assert.equal(await listKind(harness.db, a, "PEST@pest.example"), "block", "case-insensitive");
  assert.deepEqual(await inboundVerdict(harness.db, a, "pest@pest.example", PASS), { folder: "quarantine", reason: "blocklisted" });
  assert.deepEqual(await inboundVerdict(harness.db, b, "pest@pest.example", PASS), { folder: "inbox", reason: "clean" }, "another mailbox is unaffected");
});

test("the list stores no address in the clear", async () => {
  const tenant = await mailbox("spam-blind");
  await reportSpam(harness.db, tenant, "secret.friend@private.example");
  const rows = await harness.db.query(`select * from cumulus_mail.spam_lists where tenant_id = $1`, [tenant]);
  assert.equal(JSON.stringify(rows).includes("secret.friend"), false);
});

test("Not spam allows the sender — but only for mail that passed authentication", async () => {
  const tenant = await mailbox("spam-allow");
  // Make the domain look bad to everyone, then allow one sender.
  for (let i = 0; i < MIN_REPORTS; i += 1) await reportSpam(harness.db, await mailbox(`spam-voter-${i}`), `x${i}@bulk.example`);
  assert.equal(badReputation(await reputation(harness.db, "bulk.example")), true);
  await reportNotSpam(harness.db, tenant, "friend@bulk.example");
  assert.deepEqual(await inboundVerdict(harness.db, tenant, "friend@bulk.example", PASS), { folder: "inbox", reason: "allowlisted" });
  // A forged From: of the allowed address, with no authentication, does not get the pass.
  assert.deepEqual(await inboundVerdict(harness.db, tenant, "friend@bulk.example", NONE), { folder: "quarantine", reason: "reputation" });
});

test("the sending domain's own DMARC quarantine policy is never overridden by an allowlist", async () => {
  const tenant = await mailbox("spam-dmarc");
  await reportNotSpam(harness.db, tenant, "boss@corp.example");
  assert.deepEqual(await inboundVerdict(harness.db, tenant, "boss@corp.example", DMARC_QUARANTINE), { folder: "quarantine", reason: "authentication" });
});

test("reputation needs enough reports, mostly spam, before it counts", () => {
  assert.equal(badReputation({ spam: MIN_REPORTS - 1, ham: 0 }), false, "too few reports");
  assert.equal(badReputation({ spam: MIN_REPORTS, ham: 0 }), true);
  assert.equal(badReputation({ spam: 8, ham: 3 }), false, "under 80% spam");
  assert.equal(badReputation({ spam: 8, ham: 2 }), true);
});

test("one mailbox gets one vote per sender: pressing Report spam again counts nothing", async () => {
  const tenant = await mailbox("spam-onevote");
  for (let i = 0; i < 10; i += 1) await reportSpam(harness.db, tenant, "repeat@onevote.example");
  assert.equal((await reputation(harness.db, "onevote.example")).spam, 1);
  // Changing one's mind is a real change and counts.
  await reportNotSpam(harness.db, tenant, "repeat@onevote.example");
  assert.deepEqual(await reputation(harness.db, "onevote.example"), { received: 0, spam: 1, ham: 1 });
});

test("RBL: off unless zones are configured; listed domains go to Quarantine", async () => {
  const tenant = await mailbox("spam-rbl");
  const resolve = fixtureRbl(["listed.example.dbl.example.org"]);
  assert.deepEqual(rblZones({}), []);
  assert.deepEqual(await inboundVerdict(harness.db, tenant, "a@listed.example", PASS, { env: {}, resolve }), { folder: "inbox", reason: "clean" });
  const env = { MAIL_RBL_ZONES: "dbl.example.org" };
  assert.deepEqual(await inboundVerdict(harness.db, tenant, "a@listed.example", PASS, { env, resolve }), { folder: "quarantine", reason: "rbl" });
  assert.deepEqual(await inboundVerdict(harness.db, tenant, "a@fine.example", PASS, { env, resolve }), { folder: "inbox", reason: "clean" });
});

test("RBL: an error answer, a resolver failure or a timeout is not a listing", async () => {
  const zones = ["dbl.example.org"];
  assert.equal(await rblListed("err.example", zones, fixtureRbl([], ["err.example.dbl.example.org"])), false, "127.255.255.x is an error code");
  assert.equal(await rblListed("x.example", zones, async () => { throw new Error("SERVFAIL"); }), false);
  assert.equal(await rblListed("slow.example", zones, () => new Promise(() => undefined), 50), false, "a hung resolver times out");
  assert.deepEqual(rblZones({ MAIL_RBL_ZONES: " dbl.example.org , not a zone,zen.example.net" }), ["dbl.example.org", "zen.example.net"]);
});

test("the DoH resolver reads A answers and nothing else", async () => {
  const fetcher = (async (url: string) => {
    assert.match(url, /^https:\/\/doh\.example\/q\?name=a\.example\.dbl\.example\.org&type=A$/);
    return new Response(JSON.stringify({ Answer: [{ type: 5, data: "cname." }, { type: 1, data: "127.0.1.2" }] }));
  }) as unknown as typeof fetch;
  assert.deepEqual(await dohResolver({ MAIL_RBL_DOH_URL: "https://doh.example/q" }, fetcher)("a.example.dbl.example.org"), ["127.0.1.2"]);
});

test("inbound mail from a blocked sender lands in Quarantine", async () => {
  const tenant = await mailbox("spam-inbound");
  await reportSpam(harness.db, tenant, "pest@pest-inbound.example");
  const raw = new TextEncoder().encode(
    ["From: Pest <pest@pest-inbound.example>", "To: spam-inbound@cumuluscloud.app", "Subject: Buy now", "", "Cheap."].join("\r\n"),
  );
  await ingestInboundEmail(harness.db, harness.storageFor, { from: "pest@pest-inbound.example", to: "spam-inbound@cumuluscloud.app", raw });
  const snapshot = await readSnapshot(harness.db, tenant);
  const message = snapshot.messages.find((m) => m.subject === "Buy now");
  assert.equal(message?.folder, "quarantine");
  assert.equal(await messageSender(harness.db, tenant, message!.id), "pest@pest-inbound.example");
  assert.equal(await messageSender(harness.db, "spam-a", message!.id), null, "another mailbox cannot report it");
});
