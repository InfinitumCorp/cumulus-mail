import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAddressList, parseHeaders, parseMime } from "./mime.ts";
import type { MailMessage } from "./model.ts";
import { catchAllAddress, cleanDomain, stripPlus } from "./routing.ts";
import { assessPhishing, classifyLink, extractLinks, stripRemoteImages } from "./safety.ts";
import { isHeld, releaseDue, sanitizeExtra } from "./schedule.ts";
import { buildSearchIndex, indexContainsPlaintext, queryIndex, tokensOf } from "./search-index.ts";

function message(extra: Partial<MailMessage> = {}): MailMessage {
  return {
    id: "m-1",
    threadId: "t-1",
    folder: "inbox",
    from: { name: "Leah", email: "leah@cumuluscloud.app" },
    to: [{ name: "Alex", email: "alex@cumuluscloud.app" }],
    cc: [],
    subject: "Notes",
    body: "See you Thursday.",
    at: "2026-11-01T00:00:00.000Z",
    unread: true,
    starred: false,
    labels: [],
    ...extra,
  };
}

// ---- routing -------------------------------------------------------------

test("plus-addressing strips the tag and normalizes case; odd input is left alone", () => {
  assert.equal(stripPlus("Ada+News@CumulusCloud.app"), "ada@cumuluscloud.app");
  assert.equal(stripPlus("ada@cumuluscloud.app"), "ada@cumuluscloud.app");
  assert.equal(stripPlus("+tag@cumuluscloud.app"), "+tag@cumuluscloud.app");
  assert.equal(stripPlus("no-at-sign"), "no-at-sign");
  assert.equal(stripPlus("a+b+c@x.example"), "a@x.example");
  assert.equal(catchAllAddress(" Example.ORG "), "*@example.org");
});

test("custom domains must be real hostnames and not the platform domain", () => {
  assert.equal(cleanDomain("Mail.Example.org.", "cumuluscloud.app"), "mail.example.org");
  assert.equal(cleanDomain("cumuluscloud.app", "cumuluscloud.app"), null);
  for (const bad of ["", "localhost", "-bad.example", "bad-.example", "a..b.example", "exa mple.org", "x.example/path", `${"a".repeat(64)}.example`]) {
    assert.equal(cleanDomain(bad, "cumuluscloud.app"), null, bad);
  }
});

// ---- MIME ----------------------------------------------------------------

test("address lists keep quoted commas and bare addresses", () => {
  assert.deepEqual(parseAddressList('"Reid, Alex" <alex@cumuluscloud.app>, leah@cumuluscloud.app, Priya <priya@vyral.example>'), [
    { name: "Reid, Alex", email: "alex@cumuluscloud.app" },
    { name: "leah", email: "leah@cumuluscloud.app" },
    { name: "Priya", email: "priya@vyral.example" },
  ]);
  assert.deepEqual(parseAddressList(undefined), []);
  assert.deepEqual(parseAddressList(""), []);
});

test("headers are lowercased, folded lines joined", () => {
  assert.deepEqual(parseHeaders("Subject: a long\r\n subject line\r\nX-Thing: 1"), { subject: "a long subject line", "x-thing": "1" });
});

test("multipart mail: quoted-printable text, base64 attachment, encoded-word subject and file name", () => {
  const raw = [
    "From: =?UTF-8?B?WsOrw6s=?= <zoe@example.org>",
    "To: alex@cumuluscloud.app",
    "Subject: =?UTF-8?Q?Caf=C3=A9_menu?=",
    'Content-Type: multipart/mixed; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Price: 5=E2=82=AC, soft line=",
    " break.",
    "--b1",
    'Content-Type: application/pdf; name="=?UTF-8?B?bWVuw7wucGRm?="',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("%PDF-1.4").toString("base64"),
    "--b1--",
    "",
  ].join("\r\n");
  const parsed = parseMime(raw);
  assert.equal(parsed.subject, "Café menu");
  assert.equal(parsed.text, "Price: 5€, soft line break.");
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0]?.name, "menü.pdf");
  assert.equal(parsed.attachments[0]?.contentType, "application/pdf");
  assert.equal(Buffer.from(parsed.attachments[0]!.bytes).toString(), "%PDF-1.4");
});

test("nested multipart/alternative uses the plain part; HTML-only mail falls back to text", () => {
  const alt = [
    'Content-Type: multipart/alternative; boundary="alt"',
    "",
    "--alt",
    "Content-Type: text/plain",
    "",
    "Plain wins",
    "--alt",
    "Content-Type: text/html",
    "",
    "<p>HTML loses</p>",
    "--alt--",
  ].join("\r\n");
  assert.equal(parseMime(alt).text, "Plain wins");
  const html = 'Content-Type: text/html\r\n\r\n<p>Hello <b>there</b></p>';
  assert.equal(parseMime(html).text, "Hello there");
  assert.equal(parseMime("Subject: bare\r\n\r\nJust text").text, "Just text");
});

test("a delivery-status part is not treated as an attachment", () => {
  const dsn = [
    'Content-Type: multipart/report; report-type=delivery-status; boundary="r"',
    "",
    "--r",
    "Content-Type: text/plain",
    "",
    "Delivery failed.",
    "--r",
    "Content-Type: message/delivery-status",
    "",
    "Final-Recipient: rfc822; gone@example.org",
    "Action: failed",
    "--r--",
  ].join("\r\n");
  const parsed = parseMime(dsn);
  assert.equal(parsed.text, "Delivery failed.");
  assert.equal(parsed.attachments.length, 0);
});

test("8-bit UTF-8 text inside a quoted-printable part survives decoding", () => {
  // Senders do put raw UTF-8 next to =XX escapes; it must not turn into U+FFFD.
  const raw = "Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nCafé =E2=82=AC5";
  assert.equal(parseMime(new TextEncoder().encode(raw)).text, "Café €5");
});

// ---- safety --------------------------------------------------------------

test("links are extracted once each, without trailing punctuation, capped at 20", () => {
  assert.deepEqual(extractLinks("Go to https://a.example/x. Or (https://b.example/y), then https://a.example/x!"), [
    "https://a.example/x",
    "https://b.example/y",
    "https://a.example/x!",
  ]);
  const many = Array.from({ length: 30 }, (_, index) => `https://h${index}.example`).join(" ");
  assert.equal(extractLinks(many).length, 20);
  assert.deepEqual(extractLinks("no links, ftp://x.example"), []);
});

test("link classification flags invalid, punycode, look-alike and userinfo tricks", () => {
  assert.equal(classifyLink("https://cumuluscloud.app/x").suspicious, false);
  assert.equal(classifyLink("https://drive.cumuluscloud.app/x").suspicious, false);
  assert.equal(classifyLink("https://example.org").suspicious, false);
  assert.match(classifyLink("https://cumulus-cloud.app.evil.example/login").reason ?? "", /imitates/);
  assert.match(classifyLink("https://cumulusmail-support.example").reason ?? "", /imitates/);
  assert.match(classifyLink("https://xn--80ak6aa92e.com").reason ?? "", /punycode/);
  assert.match(classifyLink("https://cumulus.login@evil.example/").reason ?? "", /hides its real host/);
  assert.match(classifyLink("https://").reason ?? "", /not a valid/);
});

test("remote images are removed; inline and data images stay", () => {
  const html = '<img src="https://t.example/p.gif"><img src=http://t.example/q.gif><img src="cid:logo"><img src="data:image/png;base64,AA==">';
  const result = stripRemoteImages(html);
  assert.equal(result.blocked, 2);
  assert.equal(result.html, '<img src="cid:logo"><img src="data:image/png;base64,AA==">');
});

test("phishing verdicts: ok, review, phishing", () => {
  assert.deepEqual(assessPhishing(message()), { verdict: "ok", reasons: [] });
  const review = assessPhishing(message({ from: { name: "Shop", email: "x@shop.example" }, body: "Urgent: verify your order at https://shop.example/o" }));
  assert.equal(review.verdict, "review");
  assert.match(review.reasons.join(" "), /urgent action/);
  const spoof = assessPhishing(message({ from: { name: "Cumulus Security", email: "alerts@secure-mail.example" } }));
  assert.equal(spoof.verdict, "phishing");
  const quarantined = assessPhishing(
    message({ auth: { spf: "fail", dkim: "none", dmarc: "fail", policy: "reject", disposition: "quarantine" } }),
  );
  assert.equal(quarantined.verdict, "phishing");
});

// ---- search index --------------------------------------------------------

test("the search index matches every query word, stores no plaintext, and depends on the secret", async () => {
  assert.deepEqual(tokensOf("Hello, hello WORLD a ada@cumuluscloud.app"), ["hello", "world", "ada@cumuluscloud.app"]);
  const index = await buildSearchIndex("Thursday briefing with Priya", "secret-1");
  assert.equal(index.length, 4);
  assert.equal(indexContainsPlaintext(index, "Thursday briefing with Priya"), false);
  assert.equal(await queryIndex(index, "secret-1", "priya BRIEFING"), true);
  assert.equal(await queryIndex(index, "secret-1", "priya friday"), false);
  assert.equal(await queryIndex(index, "secret-1", "  "), true);
  assert.equal(await queryIndex(index, "secret-2", "priya"), false);
  assert.equal(indexContainsPlaintext(["thursday"], "Thursday"), true);
});

// ---- schedule ------------------------------------------------------------

test("extras are cleaned: bad dates dropped, protection clamped, only Drive links kept", () => {
  const clean = sanitizeExtra({
    scheduleAt: "not a date",
    heldUntil: "2026-11-01T00:00:00.000Z",
    readReceipt: "maybe" as never,
    pgp: true,
    protection: {
      salt: "s".repeat(200),
      iv: "i".repeat(100),
      ciphertext: "c",
      expiresAt: "2026-12-01T00:00:00.000Z",
      readsLeft: 999,
      selfDestruct: true,
      iterations: 5,
    },
    cloudLinks: [
      { name: "a.pdf", size: 10.7, href: "https://evil.example/a.pdf", expiresAt: "x" },
    ],
  });
  assert.equal(clean?.scheduleAt, undefined);
  assert.equal(clean?.heldUntil, "2026-11-01T00:00:00.000Z");
  assert.equal(clean?.readReceipt, undefined);
  assert.equal(clean?.pgp, true);
  assert.equal(clean?.protection?.salt.length, 80);
  assert.equal(clean?.protection?.iv.length, 40);
  assert.equal(clean?.protection?.readsLeft, 100);
  assert.equal(clean?.protection?.iterations, 1000);
  assert.equal(clean?.cloudLinks, undefined);
  assert.equal(sanitizeExtra({}), undefined);
  assert.equal(sanitizeExtra(undefined), undefined);
});

test("undo holds and schedules release at their time, not before", () => {
  const now = Date.parse("2026-11-12T10:00:00.000Z");
  const held = message({ folder: "sent", extra: { heldUntil: "2026-11-12T10:00:05.000Z" } });
  assert.equal(isHeld(held, now), true);
  assert.equal(isHeld(held, now + 5_000), false);
  assert.equal(isHeld(message(), now), false);
  const draft = message({ folder: "drafts", extra: { scheduleAt: "2026-11-12T10:00:00.000Z", pgp: true } });
  const [released] = releaseDue([draft], now);
  assert.equal(released?.folder, "sent");
  assert.deepEqual(released?.extra, { pgp: true });
  // A schedule on a message that is not a draft is ignored.
  const list = [message({ folder: "inbox", extra: { scheduleAt: "2000-01-01T00:00:00.000Z" } })];
  assert.equal(releaseDue(list, now), list);
});
