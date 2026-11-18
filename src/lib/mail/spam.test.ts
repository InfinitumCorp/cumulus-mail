import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ingestInboundEmail } from "./inbound.ts";
import { openMailbox } from "./mailbox.ts";
import type { MailAuth } from "./model.ts";
import { readSnapshot } from "./records.ts";
import {
  authenticatedForDomain,
  badReputation,
  dohResolver,
  inboundVerdict,
  listKind,
  MIN_REPORTS,
  messageSender,
  rblListed,
  rblZones,
  reportedMessage,
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
  // Forged mail (no authentication) is delivered by the same rules but not counted for the domain.
  await inboundVerdict(harness.db, tenant, "hi@clean.example", NONE);
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
  for (let i = 0; i < MIN_REPORTS; i += 1) await reportSpam(harness.db, await mailbox(`spam-voter-${i}`), `x${i}@bulk.example`, PASS);
  assert.equal(badReputation(await reputation(harness.db, "bulk.example")), true);
  await reportNotSpam(harness.db, tenant, "friend@bulk.example", PASS);
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

test("one mailbox gets one vote per domain: pressing Report spam again counts nothing", async () => {
  const tenant = await mailbox("spam-onevote");
  for (let i = 0; i < 10; i += 1) await reportSpam(harness.db, tenant, "repeat@onevote.example", PASS);
  assert.equal((await reputation(harness.db, "onevote.example")).spam, 1);
  // Changing one's mind moves the vote rather than adding a second one.
  await reportNotSpam(harness.db, tenant, "repeat@onevote.example", PASS);
  assert.deepEqual(await reputation(harness.db, "onevote.example"), { received: 0, spam: 0, ham: 1 });
});

test("one person cannot sink a big domain by reporting many of its addresses", async () => {
  const tenant = await mailbox("spam-sybil");
  for (let i = 0; i < 20; i += 1) await reportSpam(harness.db, tenant, `user${i}@bigmail.example`, PASS);
  assert.equal((await reputation(harness.db, "bigmail.example")).spam, 1, "twenty addresses, one mailbox: one vote");
  assert.equal(badReputation(await reputation(harness.db, "bigmail.example")), false);
  // Each address is still blocked for this mailbox.
  assert.equal(await listKind(harness.db, tenant, "user7@bigmail.example"), "block");
});

test("mail that did not authenticate as its domain cannot vote on that domain", async () => {
  // Forged "From: …@forged.example" reported by five different mailboxes: blocked for each of them, no votes.
  for (let i = 0; i < MIN_REPORTS + 2; i += 1) {
    const voter = await mailbox(`spam-forged-${i}`);
    await reportSpam(harness.db, voter, `ceo@forged.example`, i % 2 ? NONE : undefined);
    assert.equal(await listKind(harness.db, voter, "ceo@forged.example"), "block");
  }
  assert.deepEqual(await reputation(harness.db, "forged.example"), { received: 0, spam: 0, ham: 0 });
  const spfOnly: MailAuth = { spf: "pass", dkim: "none", dmarc: "fail", policy: "none", disposition: "deliver" };
  await reportSpam(harness.db, await mailbox("spam-forged-spf"), "ceo@forged.example", spfOnly);
  assert.equal((await reputation(harness.db, "forged.example")).spam, 0, "an SPF pass for some other domain is not enough");
});

test("a domain that sends a lot needs proportionally more spam votes", () => {
  assert.equal(badReputation({ spam: MIN_REPORTS, ham: 0, received: 1_000 }), true, "0.5% of 1,000 messages");
  assert.equal(badReputation({ spam: MIN_REPORTS, ham: 0, received: 100_000 }), false, "five votes against 100,000 messages");
  assert.equal(badReputation({ spam: 100, ham: 0, received: 100_000 }), true, "0.1% of them");
});

test("votes are stored without a mailbox id, and one mailbox's votes on different domains do not link up", async () => {
  const tenant = await mailbox("spam-votes-private");
  await reportSpam(harness.db, tenant, "a@one.example", PASS);
  await reportSpam(harness.db, tenant, "b@two.example", PASS);
  const rows = await harness.db.query<{ domain: string; voter: string }>(
    `select domain, voter from cumulus_mail.spam_votes where domain in ('one.example', 'two.example') order by domain`,
  );
  assert.equal(rows.length, 2);
  assert.equal(JSON.stringify(rows).includes(tenant), false);
  assert.notEqual(rows[0].voter, rows[1].voter);
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
  // A report carries the stored authentication result. Without live DNS it is "none", so it does not vote.
  const reported = await reportedMessage(harness.db, tenant, message!.id);
  assert.equal(reported?.from, "pest@pest-inbound.example");
  assert.equal(reported?.auth?.dmarc, "none");
  assert.equal(authenticatedForDomain(reported?.auth), false);
});

test("received: exact below 1,000, then sampled (1 in 16 adds 16) so a big domain's row takes far fewer writes", async () => {
  const { countReceived, RECEIVED_SAMPLE, RECEIVED_SAMPLE_FROM } = await import("./spam.ts");
  const db = harness.db;
  const writes: string[] = [];
  const counting = { query: (sql: string, params?: unknown[]) => (writes.push(sql), db.query(sql, params)) } as typeof db;

  // Small domain: every message counts, exactly.
  for (let i = 0; i < 3; i += 1) await countReceived(counting, "small.example", i, () => 0.99);
  assert.equal((await reputation(db, "small.example")).received, 3);
  assert.equal(writes.length, 3);

  // Big domain: a draw below 1/16 adds 16, anything else writes nothing.
  writes.length = 0;
  await countReceived(counting, "big.example", RECEIVED_SAMPLE_FROM, () => 0.5);
  assert.equal(writes.length, 0, "no write for the other 15 in 16");
  await countReceived(counting, "big.example", RECEIVED_SAMPLE_FROM, () => 0.01);
  assert.equal((await reputation(db, "big.example")).received, RECEIVED_SAMPLE);

  // Over many messages the count stays close to the truth (seeded generator, so the test is stable).
  let seed = 42;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  writes.length = 0;
  const messages = 16_000;
  for (let i = 0; i < messages; i += 1) await countReceived(counting, "huge.example", RECEIVED_SAMPLE_FROM, random);
  const counted = (await reputation(db, "huge.example")).received;
  assert.ok(Math.abs(counted - messages) / messages < 0.1, `counted ${counted} for ${messages}`);
  assert.ok(writes.length < messages / 10, `${writes.length} writes for ${messages} messages`);
});

test("mail from outside claiming the platform's own domain is quarantined unless it passes DMARC; not-spam cannot release it", async () => {
  const tenant = "spoof-own";
  await openMailbox(harness.db, tenant, profile(tenant, "spoof.own@cumuluscloud.app", "Own"));
  const unauthenticated: MailAuth = { spf: "none", dkim: "none", dmarc: "none", policy: "none", disposition: "deliver" };
  // Before MAIL_AUTH_DNS=live nothing passes DMARC: a forged "support@" or colleague goes to Quarantine.
  assert.deepEqual(await inboundVerdict(harness.db, tenant, "support@cumuluscloud.app", unauthenticated), { folder: "quarantine", reason: "own-domain" });
  assert.deepEqual(await inboundVerdict(harness.db, tenant, "CEO@CumulusCloud.App", unauthenticated), { folder: "quarantine", reason: "own-domain" });
  // The person marking one "not spam" (an allow-list entry) does not make the next forgery land.
  await reportNotSpam(harness.db, tenant, "support@cumuluscloud.app", unauthenticated);
  assert.deepEqual(await inboundVerdict(harness.db, tenant, "support@cumuluscloud.app", unauthenticated), { folder: "quarantine", reason: "own-domain" });
  // Our own DKIM-signed mail relayed back (a list) passes DMARC and is delivered.
  assert.equal((await inboundVerdict(harness.db, tenant, "alex@cumuluscloud.app", PASS)).folder, "inbox");
  // Other domains, including look-alikes and subdomains, are judged as before.
  assert.equal((await inboundVerdict(harness.db, tenant, "hi@cumuluscloud.app.example", unauthenticated)).folder, "inbox");
  assert.equal((await inboundVerdict(harness.db, tenant, "hi@clean-other.example", unauthenticated)).folder, "inbox");
});
