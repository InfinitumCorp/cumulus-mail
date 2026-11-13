/**
 * Outbound deliverability: what a receiving server checks, checked the way it would check it.
 * List-Unsubscribe parsing and RFC 8058 one-click are in categories.test.ts; retries, bounces and
 * suppression in outbound.test.ts and dsn.test.ts.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { authenticateInbound, type DNSResolver } from "../authenticate.ts";
import type { MailMessage } from "../model.ts";
import { dkimDnsRecord, signMessage, splitMessage } from "./dkim.ts";
import { buildRawMessage } from "./message.ts";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const DOMAIN = "cumuluscloud.app";
const SELECTOR = "cm2026";

const message = (overrides: Partial<MailMessage> = {}): MailMessage => ({
  id: "out-1",
  threadId: "out-1",
  folder: "sent",
  from: { name: "Alex Reid", email: "alex@cumuluscloud.app" },
  to: [{ name: "Leah", email: "leah@example.org" }],
  cc: [],
  subject: "Quarterly numbers — final",
  body: "Hello Leah,\n\nThe numbers are attached.\n",
  at: "2026-11-13T09:30:00.000Z",
  unread: false,
  starred: false,
  labels: [],
  ...overrides,
});

/** A receiver's DNS for cumuluscloud.app with exactly the records docs/deploy/dns-records.md lists. */
function publishedDns(record = dkimDnsRecord(PEM)): DNSResolver {
  const records: Record<string, string> = {
    [`txt ${SELECTOR}._domainkey.${DOMAIN}`]: record,
    [`txt ${DOMAIN}`]: "v=spf1 ip4:192.0.2.10 -all",
    [`txt _dmarc.${DOMAIN}`]: "v=DMARC1; p=quarantine; adkim=s; aspf=r; rua=mailto:dmarc@cumuluscloud.app",
  };
  return async (domain, rrtype) => {
    const hit = records[`${rrtype} ${domain}`.toLowerCase()];
    return hit ? [[hit]] : [];
  };
}

const signed = (raw: string) => signMessage(raw, { domain: DOMAIN, selector: SELECTOR, privateKeyPem: PEM });
const envelope = { sender: "alex@cumuluscloud.app", ip: "192.0.2.10", helo: "mail.cumuluscloud.app" };

test("the published DKIM record has the RFC 6376 form and carries the public half of the signing key", () => {
  const record = dkimDnsRecord(PEM);
  assert.match(record, /^v=DKIM1; k=rsa; p=[A-Za-z0-9+/]+=*$/);
  assert.ok(record.length > 380, "a 2048-bit key (longer than one 255-byte TXT string: publish it split)");
  assert.doesNotMatch(record, /PRIVATE/);
});

test("a signed outgoing message passes DKIM, SPF and DMARC at a receiver that reads the published records", async () => {
  const raw = signed(buildRawMessage(message(), message().from, DOMAIN, new Date("2026-11-13T09:30:00Z")));
  const auth = await authenticateInbound(raw, envelope, publishedDns());
  assert.equal(auth.dkim, "pass");
  assert.equal(auth.spf, "pass");
  assert.equal(auth.dmarc, "pass", "aligned: d= and the From domain are both cumuluscloud.app");
  assert.equal(auth.disposition, "deliver");
});

test("DKIM fails at the receiver if the body or a signed header changes in transit, or the wrong key is published", async () => {
  const raw = signed(buildRawMessage(message(), message().from, DOMAIN));
  const tamperedBody = raw.replace(/\r\n\r\n([A-Za-z0-9+/=]+)/, (_, b64) => `\r\n\r\n${b64.slice(0, -4)}QUFB`);
  // mailauth reports a body-hash mismatch as "neutral" and a bad signature as "fail": never "pass".
  assert.notEqual((await authenticateInbound(tamperedBody, envelope, publishedDns())).dkim, "pass");
  const tamperedSubject = raw.replace(/^Subject: .*$/m, "Subject: Changed");
  assert.notEqual((await authenticateInbound(tamperedSubject, envelope, publishedDns())).dkim, "pass");
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const wrongKey = await authenticateInbound(raw, envelope, publishedDns(dkimDnsRecord(other)));
  assert.notEqual(wrongKey.dkim, "pass");
  // DMARC passes on either aligned SPF or aligned DKIM: with DKIM broken, the SPF record alone carries
  // it. Both records are needed: forwarding breaks SPF, so DKIM is what survives a forward.
  assert.equal(wrongKey.spf, "pass");
  assert.equal(wrongKey.dmarc, "pass");
});

test("the signature covers the headers a receiver and DMARC rely on", () => {
  const raw = signed(buildRawMessage(message({ cc: [{ name: "Sam", email: "sam@example.org" }] }), message().from, DOMAIN));
  const header = raw.split("\r\n").slice(0, 3).join(" ");
  const h = /\bh=([^;]+)/.exec(header)?.[1]?.split(":").map((s) => s.trim()) ?? [];
  for (const name of ["from", "to", "cc", "subject", "date", "message-id", "mime-version", "content-type"]) {
    assert.ok(h.includes(name), `${name} is signed`);
  }
  assert.match(header, /\ba=rsa-sha256\b/);
  assert.match(header, /\bc=relaxed\/relaxed\b/);
  assert.match(header, new RegExp(`\\bd=${DOMAIN}\\b`));
});

test("Message-ID and Date are RFC 5322: a unique id on our domain, and a dated header with a numeric zone", () => {
  const raw = buildRawMessage(message({ id: "out-9f3/<x>" }), message().from, DOMAIN, new Date("2026-11-13T09:30:05Z"));
  const { headers } = splitMessage(raw);
  const get = (name: string) => headers.find((h) => h.name.toLowerCase() === name)?.value.trim() ?? "";
  assert.equal(get("message-id"), `<out-9f3x@${DOMAIN}>`, "id-left is a dot-atom; nothing from the id can break out of <>");
  assert.match(get("date"), /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} \+0000$/);
  assert.equal(get("date"), "Fri, 13 Nov 2026 09:30:05 +0000");
  // Distinct messages get distinct ids.
  const other = splitMessage(buildRawMessage(message({ id: "out-10" }), message().from, DOMAIN)).headers.find((h) => h.name === "Message-ID")?.value;
  assert.notEqual(other?.trim(), get("message-id"));
});

test("person-to-person mail carries no List-Unsubscribe: that header is for bulk mail (RFC 2369, RFC 8058)", () => {
  const raw = buildRawMessage(message(), message().from, DOMAIN);
  assert.doesNotMatch(raw, /^List-Unsubscribe/im);
  assert.doesNotMatch(raw, /^Precedence: bulk/im);
});

test("header injection through a subject or a name cannot add a header", () => {
  const raw = buildRawMessage(
    message({ subject: "Hi\r\nBcc: victim@example.org", to: [{ name: "Leah\r\nBcc: x@example.org", email: "leah@example.org" }] }),
    message().from,
    DOMAIN,
  );
  const names = splitMessage(raw).headers.map((h) => h.name.toLowerCase());
  assert.ok(!names.includes("bcc"));
});
