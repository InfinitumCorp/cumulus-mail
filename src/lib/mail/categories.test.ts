import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  categorize,
  oneClickUnsubscribe,
  safeUnsubscribeUrl,
  subscriptions,
  unsubscribeOptions,
} from "./categories.ts";
import { openMailbox } from "./mailbox.ts";
import type { MailMessage } from "./model.ts";
import { insertMessage, readSettings } from "./records.ts";
import { defaultSettings, noteUnsubscribed, sanitizeSettings } from "./settings.ts";
import { createHarness, profile } from "./test-support.ts";
import { unsubscribeMessage } from "./unsubscribe.ts";

function mail(id: string, from: string, headers: Record<string, string> = {}, extra: Partial<MailMessage> = {}): MailMessage {
  return {
    id,
    threadId: id,
    folder: "inbox",
    from: { name: from.split("@")[0]!, email: from },
    to: [{ name: "Ada", email: "ada@cumuluscloud.app" }],
    cc: [],
    subject: `Subject ${id}`,
    body: "Hello",
    at: "2026-11-10T10:00:00.000Z",
    unread: true,
    starred: false,
    labels: [],
    headers,
    ...extra,
  };
}

test("a person writing directly stays Primary", () => {
  assert.equal(categorize(mail("p1", "leah@cumuluscloud.app")), "primary");
  assert.equal(categorize(mail("p2", "jordan@vyral.example", {}, { headers: undefined })), "primary");
  assert.equal(categorize(mail("p3", "jordan@vyral.example", { "auto-submitted": "no" })), "primary");
});

test("list and automated mail is Updates", () => {
  assert.equal(categorize(mail("u1", "builds@ci.example", { "list-id": "<builds.ci.example>" })), "updates");
  assert.equal(categorize(mail("u2", "x@bank.example", { precedence: "bulk" })), "updates");
  assert.equal(categorize(mail("u3", "x@shop.example", { "auto-submitted": "auto-generated" })), "updates");
  assert.equal(categorize(mail("u4", "no-reply@accounts.example")), "updates");
  assert.equal(categorize(mail("u5", "notifications+abc@service.example")), "updates");
});

test("marketing list mail is Promotions", () => {
  const unsub = { "list-unsubscribe": "<https://shop.example/u?id=1>" };
  assert.equal(categorize(mail("m1", "deals@shop.example", unsub, { subject: "Black Friday: 40% off everything" })), "promotions");
  assert.equal(categorize(mail("m2", "hello@brand.example", { ...unsub, "x-mailchimp-campaign": "abc" })), "promotions");
  assert.equal(categorize(mail("m3", "hello@brand.example", { precedence: "junk" })), "promotions");
  // Promotional words alone, without any list signal, do not move a personal email.
  assert.equal(categorize(mail("m4", "friend@example.org", {}, { subject: "Found a great deal on flights" })), "primary");
});

test("social networks are Social", () => {
  assert.equal(categorize(mail("s1", "notification@facebookmail.com", { "list-unsubscribe": "<https://facebook.com/u>" })), "social");
  assert.equal(categorize(mail("s2", "messages-noreply@linkedin.com")), "social");
  assert.equal(categorize(mail("s3", "x@mailer.example", { "x-linkedin-class": "INVITE" })), "social");
  assert.equal(categorize(mail("s4", "x@lists.example", { "list-id": "Group <group.meetup.com>" })), "social");
});

test("List-Unsubscribe parsing prefers RFC 8058 one-click, then mailto, then a link", () => {
  const both = {
    "list-unsubscribe": "<mailto:leave@lists.example?subject=Remove%20me>, <https://lists.example/u/123>",
    "list-unsubscribe-post": "List-Unsubscribe=One-Click",
  };
  const options = unsubscribeOptions(both);
  assert.deepEqual(options[0], { kind: "one-click", url: "https://lists.example/u/123" });
  assert.deepEqual(options[1], { kind: "mailto", address: "leave@lists.example", subject: "Remove me", body: "" });

  const noPost = unsubscribeOptions({ "list-unsubscribe": "<https://lists.example/u/123>, <mailto:leave@lists.example>" });
  assert.equal(noPost[0]?.kind, "mailto");
  assert.equal(noPost[1]?.kind, "link");

  // http (not https), javascript: and malformed targets are ignored.
  assert.deepEqual(unsubscribeOptions({ "list-unsubscribe": "<http://x.example/u>, <javascript:alert(1)>, <mailto:not an address>" }), []);
  assert.deepEqual(unsubscribeOptions(undefined), []);
  assert.equal(unsubscribeOptions({ "list-unsubscribe": "<mailto:a@b.example?subject=x%0D%0ABcc:%20c@d.example>" })[0]?.kind, "mailto");
  assert.equal(
    (unsubscribeOptions({ "list-unsubscribe": "<mailto:a@b.example?subject=x%0D%0ABcc:%20c@d.example>" })[0] as { subject: string }).subject.includes("\n"),
    false,
  );
});

test("subscriptions group by List-Id, else sender, newest option wins", () => {
  const rows = subscriptions(
    [
      mail("a1", "news@paper.example", { "list-id": "Daily <daily.paper.example>", "list-unsubscribe": "<mailto:out@paper.example>" }, { at: "2026-11-01T00:00:00.000Z" }),
      mail("a2", "editor@paper.example", {
        "list-id": "<daily.paper.example>",
        "list-unsubscribe": "<https://paper.example/u>",
        "list-unsubscribe-post": "List-Unsubscribe=One-Click",
      }, { at: "2026-11-05T00:00:00.000Z", unread: false }),
      mail("b1", "deals@shop.example", { "list-unsubscribe": "<https://shop.example/u>" }, { at: "2026-11-03T00:00:00.000Z" }),
      mail("c1", "leah@cumuluscloud.app"),
      mail("d1", "deals@shop.example", { "list-unsubscribe": "<https://shop.example/u>" }, { folder: "trash" }),
      mail("e1", "ada@cumuluscloud.app", { "list-id": "<self.example>" }),
    ],
    "ada@cumuluscloud.app",
  );
  assert.deepEqual(rows.map((row) => [row.key, row.count, row.unread, row.messageId]), [
    ["daily.paper.example", 2, 1, "a2"],
    ["deals@shop.example", 1, 1, "b1"],
  ]);
  assert.equal(rows[0]?.option?.kind, "one-click");
  assert.equal(rows[1]?.option?.kind, "link");
});

test("one-click unsubscribe only POSTs to public https hosts, as RFC 8058 says", async () => {
  for (const bad of [
    "http://lists.example/u",
    "https://localhost/u",
    "https://127.0.0.1/u",
    "https://[::1]/u",
    "https://intranet/u",
    "https://db.internal/u",
    "https://lists.example:8443/u",
    "https://user:pw@lists.example/u",
    "not a url",
  ]) {
    assert.equal(safeUnsubscribeUrl(bad), null, bad);
  }
  assert.equal(safeUnsubscribeUrl("https://lists.example/u?id=1")?.hostname, "lists.example");

  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(null, { status: 202 });
  }) as unknown as typeof fetch;
  assert.deepEqual(await oneClickUnsubscribe("https://lists.example/u?id=1", fakeFetch), { ok: true, status: 202 });
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(calls[0]?.init.body, "List-Unsubscribe=One-Click");
  assert.equal(calls[0]?.init.redirect, "manual");
  assert.equal(calls[0]?.init.credentials, "omit");
  await assert.rejects(() => oneClickUnsubscribe("https://127.0.0.1/u", fakeFetch), /not allowed/);
  assert.equal(calls.length, 1);
});

test("settings remember unsubscribed lists, deduplicated and capped", () => {
  let settings = noteUnsubscribed(defaultSettings(), "Daily.Paper.Example", "one-click", new Date("2026-11-01T00:00:00Z"));
  settings = noteUnsubscribed(settings, "daily.paper.example", "mailto", new Date("2026-11-02T00:00:00Z"));
  assert.deepEqual(settings.unsubscribed, [{ key: "daily.paper.example", at: "2026-11-02T00:00:00.000Z", method: "mailto" }]);
  assert.deepEqual(sanitizeSettings({ unsubscribed: [{ key: "x", at: "y", method: "bogus" }, { key: "Ok", at: "t", method: "link" }] }).unsubscribed, [
    { key: "ok", at: "t", method: "link" },
  ]);
  assert.deepEqual(sanitizeSettings({}).unsubscribed, []);
});

let harness: Awaited<ReturnType<typeof createHarness>>;

before(async () => {
  harness = await createHarness();
});

after(async () => {
  await harness.close();
});

test("the server unsubscribes with the URL from the stored message, not the caller", async () => {
  const { db } = harness;
  const ada = profile("cat-ada", "ada.cat@cumuluscloud.app", "Ada");
  await openMailbox(db, "cat-ada", ada);
  await insertMessage(db, "cat-ada", mail("list-1", "news@paper.example", {
    "list-id": "<daily.paper.example>",
    "list-unsubscribe": "<https://paper.example/u/abc>",
    "list-unsubscribe-post": "List-Unsubscribe=One-Click",
  }), null);
  await insertMessage(db, "cat-ada", mail("list-2", "deals@shop.example", { "list-unsubscribe": "<mailto:out@shop.example?subject=stop>" }), null);
  await insertMessage(db, "cat-ada", mail("plain-1", "leah@cumuluscloud.app"), null);

  const urls: string[] = [];
  const fakeFetch = (async (url: string) => {
    urls.push(url);
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;

  assert.deepEqual(await unsubscribeMessage(db, "cat-ada", "list-1", fakeFetch), { method: "one-click", ok: true, status: 200 });
  assert.deepEqual(urls, ["https://paper.example/u/abc"]);
  const settings = await readSettings(db, "cat-ada");
  assert.deepEqual(settings.unsubscribed.map((item) => [item.key, item.method]), [["daily.paper.example", "one-click"]]);

  const mailto = await unsubscribeMessage(db, "cat-ada", "list-2", fakeFetch);
  assert.equal(mailto.method, "mailto");
  assert.deepEqual(await unsubscribeMessage(db, "cat-ada", "plain-1", fakeFetch), { method: "none" });
  await assert.rejects(() => unsubscribeMessage(db, "cat-ada", "missing", fakeFetch), /gone/);
  assert.equal(urls.length, 1);
});
