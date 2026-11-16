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

// ---- logic ---------------------------------------------------------------

import {
  applyRules,
  audienceLabel,
  briefKey,
  formatSize,
  initials,
  inBox,
  isE2E,
  isSnoozed,
  listThreads,
  markThreadUnread,
  parsePeople,
  peopleToField,
  planDelivery,
  quota,
  quote,
  rowTitle,
  threadOf,
  tomorrowMorning,
  transcript,
  validEmail,
  withSignature,
} from "./logic.ts";
import { parseInvite } from "./invite.ts";
import { envelopeBlock, spendRead } from "./protect.ts";
import type { ProtectedEnvelope } from "./model.ts";

test("formatting helpers: sizes, initials, row titles", () => {
  assert.deepEqual([0, 1023, 1024, 1536, 1024 * 1024 - 1, 1024 * 1024, 5.5 * 1024 * 1024].map(formatSize), [
    "0 B",
    "1023 B",
    "1 KB",
    "2 KB",
    "1024 KB",
    "1.0 MB",
    "5.5 MB",
  ]);
  assert.equal(initials("Leah  Okafor-Smith"), "LO");
  assert.equal(initials("cher"), "C");
  assert.equal(initials("   "), "•");
  assert.equal(rowTitle(message()), "Leah");
  assert.equal(rowTitle(message({ from: { name: "Alex", email: "ALEX@cumuluscloud.app" } }), "alex@cumuluscloud.app"), "To Alex");
  assert.equal(rowTitle(message({ from: { name: "Alex", email: "alex@cumuluscloud.app" }, to: [] }), "alex@cumuluscloud.app"), "To —");
});

test("recipient fields parse and print back", () => {
  const people = parsePeople('"Reid" <alex@cumuluscloud.app>; leah@cumuluscloud.app, Priya <priya@vyral.example>,,');
  assert.deepEqual(people, [
    { name: "Reid", email: "alex@cumuluscloud.app" },
    { name: "leah", email: "leah@cumuluscloud.app" },
    { name: "Priya", email: "priya@vyral.example" },
  ]);
  assert.equal(peopleToField(people), "Reid <alex@cumuluscloud.app>, leah <leah@cumuluscloud.app>, Priya <priya@vyral.example>");
  assert.equal(peopleToField([{ name: "x@y.example", email: "x@y.example" }]), "x@y.example");
  assert.deepEqual(["a@b.co", "a@b", "a b@c.co", "@c.co", "a@.co"].map(validEmail), [true, false, false, false, false]);
});

test("delivery plans dedupe recipients and say where each goes", () => {
  const hops = planDelivery([
    { name: "Leah", email: "Leah@cumuluscloud.app" },
    { name: "Leah again", email: "leah@cumuluscloud.app" },
    { name: "Priya", email: "priya@vyral.example" },
  ]);
  assert.deepEqual(hops.map((hop) => [hop.email, hop.status]), [["leah@cumuluscloud.app", "inside"], ["priya@vyral.example", "outbound"]]);
  assert.match(planDelivery([{ name: "P", email: "p@x.example" }], { password: true })[0]?.detail ?? "", /Password-protected/);
  assert.equal(audienceLabel([{ name: "L", email: "leah@cumuluscloud.app" }]), "Personal");
  assert.equal(audienceLabel([{ name: "L", email: "leah@cumuluscloud.app" }, { name: "P", email: "p@x.example" }]), "External");
  assert.equal(audienceLabel([]), "External");
  assert.equal(isE2E(message()), true);
  assert.equal(isE2E(message({ cc: [{ name: "P", email: "p@x.example" }] })), false);
});

test("rules star, archive and label inbox mail only", () => {
  const rules = [
    { id: "1", from: "LEAH", action: "star" as const },
    { id: "2", from: "leah@", action: "label" as const, label: "Team" },
    { id: "3", from: "  ", action: "archive" as const },
  ];
  const next = applyRules(message(), rules);
  assert.equal(next.starred, true);
  assert.deepEqual(next.labels, ["Team"]);
  assert.equal(next.folder, "inbox");
  assert.deepEqual(applyRules(next, rules).labels, ["Team"]);
  assert.equal(applyRules(message({ folder: "sent" }), rules).starred, false);
  const archived = applyRules(message(), [{ id: "4", from: "cumuluscloud.app", action: "archive" }]);
  assert.equal(archived.folder, "archive");
  assert.equal(archived.unread, false);
});

test("signature is added once, above a quoted reply", () => {
  const signed = withSignature("Hello", "Alex\nInfinitum");
  assert.equal(signed, "Hello\n\nAlex\nInfinitum");
  assert.equal(withSignature(signed, "Alex\nInfinitum"), signed);
  assert.equal(withSignature("Hello", "  "), "Hello");
  assert.equal(withSignature("Thanks \n\n—\nOn Thu, Leah wrote:\n> hi", "Alex"), "Thanks\n\nAlex\n\n—\nOn Thu, Leah wrote:\n> hi");
});

test("threads, snooze and boxes", () => {
  const now = Date.parse("2026-11-12T10:00:00.000Z");
  const a1 = message({ id: "a1", threadId: "a", at: "2026-11-10T00:00:00.000Z", subject: "Budget", unread: false });
  const a2 = message({ id: "a2", threadId: "a", at: "2026-11-11T00:00:00.000Z", subject: "Re: Budget", body: "Numbers attached" });
  const ad = message({ id: "ad", threadId: "a", folder: "drafts", at: "2026-11-12T00:00:00.000Z" });
  const b1 = message({ id: "b1", threadId: "b", at: "2026-11-09T00:00:00.000Z", snoozeUntil: "2026-11-13T08:00:00.000Z" });
  const s1 = message({ id: "s1", threadId: "s", folder: "sent", delivery: [{ email: "p@x.example", status: "outbound", detail: "held" }] });
  const t1 = message({ id: "t1", threadId: "t", folder: "trash", starred: true });
  const all = [a1, a2, ad, b1, s1, t1];
  assert.deepEqual(threadOf(all, "a").map((m) => m.id), ["a1", "a2"]);
  assert.equal(isSnoozed(b1, now), true);
  assert.equal(isSnoozed(b1, Date.parse("2026-11-13T08:00:00.000Z")), false);
  assert.equal(inBox(b1, "inbox", now), false);
  assert.equal(inBox(b1, "snoozed", now), true);
  assert.equal(inBox(s1, "outbox", now), true);
  assert.equal(inBox(t1, "starred", now), false);
  const rows = listThreads(all, "inbox", "", false, now);
  assert.deepEqual(rows.map((m) => m.id), ["a2"]);
  assert.deepEqual(listThreads(all, "inbox", "numbers", false, now).map((m) => m.id), ["a2"]);
  assert.deepEqual(listThreads(all, "inbox", "nothing-like-this", false, now), []);
  const unread = markThreadUnread([a1, a2], "a", "alex@cumuluscloud.app");
  assert.equal(unread.find((m) => m.id === "a2")?.unread, true);
  assert.equal(briefKey([a1, a2]), "a1:a2");
});

test("snooze time, quoting, transcripts and quota", () => {
  assert.equal(tomorrowMorning(new Date("2026-12-31T23:30:00.000Z")), "2027-01-01T08:00:00.000Z");
  const quoted = quote(message({ body: "Line one\nLine two", at: "2026-11-05T20:00:00.000Z" }));
  assert.match(quoted, /^\n\n—\nOn Thu 05 Nov, 20:00 UTC, Leah wrote:\n> Line one\n> Line two$/);
  assert.match(transcript([message(), message({ id: "m-2", body: "Second" })]), /See you Thursday\.\n\n----\n\nFrom: Leah/);
  const full = quota([message({ attachments: [{ name: "big", size: 50e9 }] })], 15);
  assert.equal(full.pct, 100);
  assert.match(quota([], 15).label, /^2\.41 \/ 15 GB$/);
});

// ---- invites -------------------------------------------------------------

test("calendar invites: folded lines, parameters, all-day dates and colons in values", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:abc/123@calendar.example",
    "SUMMARY;LANGUAGE=en:Q4 review: budget and",
    "  hiring",
    "DTSTART;TZID=Europe/London:20261105T143000",
    "LOCATION:Room 4: east wing",
    "ORGANIZER;CN=Priya:mailto:priya@vyral.example",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const event = parseInvite(ics);
  assert.equal(event?.title, "Q4 review: budget and hiring");
  assert.equal(event?.where, "Room 4: east wing");
  assert.equal(event?.with, "priya@vyral.example");
  assert.equal(event?.id, "ics-abc123calendar.example");
  assert.equal(event?.sort, "2026-11-05T14:30:00.000Z");

  const allDay = parseInvite("BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Offsite\nDTSTART;VALUE=DATE:20261201\nEND:VEVENT\nEND:VCALENDAR");
  assert.equal(allDay?.whenLabel, "2026-12-01 00:00 UTC");
  assert.equal(allDay?.with, "Calendar invite");
  assert.equal(allDay?.id, "ics-Offsite");
  assert.equal(parseInvite("BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20261201\nEND:VEVENT\nEND:VCALENDAR"), null);

  // TZID times convert to UTC, across daylight saving.
  const at = (start: string) => parseInvite(`BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:x\n${start}\nEND:VEVENT\nEND:VCALENDAR`)?.sort;
  assert.equal(at("DTSTART;TZID=America/New_York:20260715T090000"), "2026-07-15T13:00:00.000Z");
  assert.equal(at("DTSTART;TZID=America/New_York:20261215T090000"), "2026-12-15T14:00:00.000Z");
  assert.equal(at('DTSTART;TZID="Asia/Kolkata":20261105T100000'), "2026-11-05T04:30:00.000Z");
  assert.equal(at("DTSTART;TZID=Europe/London:20260329T120000"), "2026-03-29T11:00:00.000Z");
  assert.equal(at("DTSTART;TZID=Europe/London:20260328T120000"), "2026-03-28T12:00:00.000Z");
  assert.equal(at("DTSTART:20261105T200000Z"), "2026-11-05T20:00:00.000Z");
  assert.equal(at("DTSTART;TZID=Not/AZone:20261105T200000"), "2026-11-05T20:00:00.000Z");
  assert.equal(parseInvite("SUMMARY:not a calendar"), null);
});

// ---- password-protected envelopes ----------------------------------------

test("protected envelopes expire, count reads, and self-destruct", () => {
  const envelope: ProtectedEnvelope = {
    salt: "c2FsdA==",
    iv: "aXY=",
    ciphertext: "Y2lwaGVy",
    expiresAt: "2026-11-20T00:00:00.000Z",
    readsLeft: 2,
    selfDestruct: false,
    iterations: 20000,
  };
  const now = Date.parse("2026-11-12T00:00:00.000Z");
  assert.equal(envelopeBlock(envelope, now), null);
  assert.match(envelopeBlock(envelope, Date.parse("2026-11-20T00:00:00.000Z")) ?? "", /expired/);
  assert.match(envelopeBlock({ ...envelope, expiresAt: "junk" }, now) ?? "", /expired/);
  const once = spendRead(envelope);
  assert.equal(once.readsLeft, 1);
  assert.equal(once.ciphertext, envelope.ciphertext);
  const twice = spendRead(once);
  assert.deepEqual([twice.readsLeft, twice.ciphertext, twice.salt, twice.iv], [0, "", "", ""]);
  assert.match(envelopeBlock(twice, now) ?? "", /already been opened/);
  const burned = spendRead({ ...envelope, selfDestruct: true });
  assert.deepEqual([burned.readsLeft, burned.ciphertext], [0, ""]);
});

test("listThreads takes the clock: a snooze that has not expired keeps a message out of the inbox", () => {
  const before = Date.parse("2026-11-12T10:00:00.000Z");
  const after = Date.parse("2026-11-13T09:00:00.000Z");
  const awake = message({ id: "a1", threadId: "a", at: "2026-11-10T00:00:00.000Z" });
  const naps = message({ id: "b1", threadId: "b", at: "2026-11-09T00:00:00.000Z", snoozeUntil: "2026-11-13T08:00:00.000Z" });
  const all = [awake, naps];
  assert.deepEqual(listThreads(all, "inbox", "", false, before).map((m) => m.id), ["a1"]);
  assert.deepEqual(listThreads(all, "snoozed", "", false, before).map((m) => m.id), ["b1"]);
  // Once it expires the same message is in the inbox and no longer snoozed - never in both.
  assert.deepEqual(listThreads(all, "inbox", "", false, after).map((m) => m.id), ["a1", "b1"]);
  assert.deepEqual(listThreads(all, "snoozed", "", false, after), []);
});
