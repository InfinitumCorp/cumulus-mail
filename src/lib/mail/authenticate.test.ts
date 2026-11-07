import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { promises as dns } from "node:dns";
import { test } from "node:test";
import { authenticate, dkimSign, type DNSResolver } from "mailauth";
import { authenticateInbound, emptyResolver, resolverFromEnv } from "./authenticate.ts";

const dnsAny = dns as typeof dns & { resolveTxt?: (host: string) => Promise<string[][]> };

function fixtureResolver(records: Record<string, string>): DNSResolver {
  return async (domain, rrtype) => {
    const hit = records[`${rrtype} ${domain}`.toLowerCase()];
    return hit ? [[hit]] : [];
  };
}

async function signed(body: string, policy: string) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const p = Buffer.from(publicKey.export({ type: "spki", format: "der" })).toString("base64");
  const raw = [
    "From: Ada <ada@example.test>",
    "To: Bob <bob@cumuluscloud.app>",
    "Subject: Hello",
    "Date: Sat, 07 Nov 2026 12:00:00 +0000",
    "Message-ID: <m1@example.test>",
    "",
    body,
    "",
  ].join("\r\n");
  const signedMessage = await dkimSign(raw, {
    signatureData: [{ signingDomain: "example.test", selector: "mail", privateKey: pem }],
  });
  const resolver = fixtureResolver({
    "txt mail._domainkey.example.test": `v=DKIM1; k=rsa; p=${p}`,
    "txt example.test": "v=spf1 ip4:203.0.113.10 -all",
    "txt _dmarc.example.test": `v=DMARC1; p=${policy}; adkim=r; aspf=r`,
  });
  return { raw: signedMessage.signatures + raw, unsigned: raw, resolver };
}

test("mailauth stores a passing result and does not query live DNS", async () => {
  const { raw, resolver } = await signed("Hello Bob", "none");
  let live = 0;
  const original = dnsAny.resolveTxt;
  dnsAny.resolveTxt = async () => {
    live += 1;
    return [];
  };
  try {
    const auth = await authenticateInbound(raw, { sender: "ada@example.test", ip: "203.0.113.10", helo: "mail.example.test" }, resolver);
    assert.equal(auth.spf, "pass");
    assert.equal(auth.dkim, "pass");
    assert.equal(auth.dmarc, "pass");
    assert.equal(auth.disposition, "deliver");
    assert.equal(live, 0);
    assert.equal(resolverFromEnv({}), emptyResolver);
    assert.equal(resolverFromEnv({ MAIL_AUTH_DNS: "live" }) === emptyResolver, false);
    const direct = await authenticate(raw, {
      sender: "ada@example.test",
      ip: "203.0.113.10",
      helo: "mail.example.test",
      resolver,
      disableArc: true,
      disableBimi: true,
    });
    assert.equal(direct.dmarc && direct.dmarc.status.result, "pass");
  } finally {
    if (original) dnsAny.resolveTxt = original;
  }
});

test("a DMARC quarantine or reject failure stays out of the inbox", async () => {
  const quarantined = await signed("nope", "quarantine");
  const held = await authenticateInbound(
    quarantined.unsigned,
    { sender: "ada@example.test", ip: "198.51.100.20", helo: "bad.example" },
    quarantined.resolver,
  );
  assert.equal(held.dmarc, "fail");
  assert.equal(held.policy, "quarantine");
  assert.equal(held.disposition, "quarantine");

  const rejected = await signed("nope", "reject");
  const dropped = await authenticateInbound(
    rejected.unsigned,
    { sender: "ada@example.test", ip: "198.51.100.20", helo: "bad.example" },
    rejected.resolver,
  );
  assert.equal(dropped.policy, "reject");
  assert.equal(dropped.disposition, "quarantine");

  const monitor = await signed("nope", "none");
  const delivered = await authenticateInbound(
    monitor.unsigned,
    { sender: "ada@example.test", ip: "198.51.100.20", helo: "bad.example" },
    monitor.resolver,
  );
  assert.equal(delivered.policy, "none");
  assert.equal(delivered.disposition, "deliver");
});
