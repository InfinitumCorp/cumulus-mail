import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { shareRequest } from "./calendar-share.ts";
import { assertLoopback, imapStep, type ImapSession } from "./bridge/imap-core.ts";
import { authorizeUrl, importConfigured, importState, messagesFromGmail, messagesFromGraph, readImportState } from "./easy-switch.ts";
import { keyUrl, lookupDirectoryKey, publishDirectoryKey } from "./id-directory.ts";
import { openOffline, sealOffline } from "./offline-store.ts";
import { listedDomain, parseFeed, resetFeedCache } from "./spam-feed.ts";
import { SEED_MESSAGES } from "./model.ts";

test("the identity directory publishes and reads a public key, and ignores anything else", async () => {
  assert.equal(keyUrl("Ada@Example.com", { CID_KEYS_URL: "https://id.example/keys" }), "https://id.example/keys/ada%40example.com");
  const stored = new Map<string, string>();
  const fetcher: typeof fetch = async (url, init) => {
    const href = String(url);
    if (init?.method === "PUT") {
      stored.set(href, String(init.body));
      return new Response(null, { status: 204 });
    }
    const body = stored.get(href);
    return body ? new Response(body) : new Response("no", { status: 404 });
  };
  const key = "-----BEGIN PGP PUBLIC KEY BLOCK-----\nabc\n-----END PGP PUBLIC KEY BLOCK-----";
  assert.equal(await publishDirectoryKey("ada@example.com", key, "token", fetcher, { CID_KEYS_URL: "https://id.example/keys" }), true);
  assert.equal(await lookupDirectoryKey("ada@example.com", fetcher, { CID_KEYS_URL: "https://id.example/keys" }), key);
  assert.equal(await lookupDirectoryKey("missing@example.com", fetcher, { CID_KEYS_URL: "https://id.example/keys" }), null);
});

test("a free feed list matches a listed domain and ignores comments", () => {
  resetFeedCache();
  const domains = parseFeed("# comment\n127.0.0.1 bad.example\nphish.test\n");
  assert.equal(listedDomain(domains, "a@bad.example"), true);
  assert.equal(listedDomain(domains, "a@news.phish.test"), true);
  assert.equal(listedDomain(domains, "a@fine.example"), false);
});

test("easy switch state is signed and Gmail and Graph rows become messages", () => {
  const state = importState("google", "tenant-ada", "secret", 1_000);
  assert.deepEqual(readImportState(state, "secret", 1_000), { provider: "google", tenantId: "tenant-ada" });
  assert.equal(readImportState(state, "other", 1_000), null);
  // The MAC is not an HMAC under the raw secret.
  const [p0, p1, p2, mac] = state.split(".");
  assert.notEqual(mac, createHmac("sha256", "secret").update(`${p0}.${p1}.${p2}`).digest("base64url"));
  assert.equal(readImportState(state, "secret", 2_000_000), null);
  const url = authorizeUrl("google", "mail.example", state, { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "sec" });
  assert.equal(url.includes("accounts.google.com"), true);
  assert.equal(url.includes("client_secret"), false);
  const [mail] = messagesFromGmail([{ id: "abc", payload: { headers: [{ name: "From", value: "Ada <ada@example.com>" }, { name: "Subject", value: "Hi" }, { name: "Date", value: "Tue, 10 Nov 2026 12:00:00 +0000" }], body: { data: Buffer.from("Hello").toString("base64url") } } }]);
  assert.equal(mail?.subject, "Hi");
  assert.equal(mail?.body, "Hello");
  const [graph] = messagesFromGraph([{ id: "g1", subject: "Outlook", bodyPreview: "Preview", from: { emailAddress: { address: "a@outlook.com" } }, receivedDateTime: "2026-11-10T12:00:00Z" }]);
  assert.equal(graph?.subject, "Outlook");
});

test("the local bridge refuses other interfaces and answers a read-only IMAP session", () => {
  assert.throws(() => assertLoopback("0.0.0.0"), /127\.0\.0\.1/);
  assert.doesNotThrow(() => assertLoopback("127.0.0.1"));
  const session: ImapSession = { authed: false, folder: null };
  const folders = [{ name: "INBOX", messages: [{ uid: 1, subject: "Hi", from: "a@example.com", to: "b@example.com", body: "Hello", seen: false, bytes: 5 }] }];
  assert.equal(imapStep(session, "a1 LOGIN bridge wrong", "secret-pass", folders).join("\n").includes("NO"), true);
  assert.equal(imapStep(session, "a2 LOGIN bridge secret-pass", "secret-pass", folders).at(-1), "a2 OK LOGIN");
  assert.equal(session.authed, true);
  assert.match(imapStep(session, "a3 LIST \"\" \"*\"", "secret-pass", folders).join("\n"), /INBOX/);
  assert.match(imapStep(session, "a4 SELECT INBOX", "secret-pass", folders).join("\n"), /READ-ONLY/);
  assert.match(imapStep(session, "a5 STORE 1 +FLAGS \\Seen", "secret-pass", folders).join("\n"), /read-only/);
});

test("an offline mailbox round-trips and a wrong passphrase does not open it", async () => {
  const sealed = await sealOffline('{"messages":[]}', "passphrase-ada");
  assert.equal(sealed.includes("messages"), false);
  assert.equal(await openOffline(sealed, "passphrase-ada"), '{"messages":[]}');
  await assert.rejects(() => openOffline(sealed, "wrong-passphrase-xx"));
});

test("sharing an event builds an invitation the recipient can be sealed for", () => {
  const event = { id: "e1", title: "Thursday", whenLabel: "", where: "Cumulus", with: "", sort: "2026-11-19T15:00:00.000Z" };
  const message = shareRequest(event, { name: "Ada", email: "ada@cumuluscloud.app" }, "bea@cumuluscloud.app", "m-share");
  assert.equal(message.folder, "sent");
  assert.match(message.body, /METHOD:REQUEST/);
  assert.match(message.body, /bea@cumuluscloud.app/);
  assert.equal(message.subject.includes(SEED_MESSAGES[0]!.subject), false);
});

test("provider import stays off until its switch is on (its callback route does not exist yet)", () => {
  const google = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" };
  assert.equal(importConfigured("google", google), false, "client ids alone do not send people to a 404");
  assert.equal(importConfigured("google", { ...google, MAIL_PROVIDER_IMPORT: "on" }), true);
  assert.equal(importConfigured("microsoft", { MAIL_PROVIDER_IMPORT: "on" }), false);
});
