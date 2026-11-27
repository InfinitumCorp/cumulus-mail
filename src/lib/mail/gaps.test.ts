import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanGroups, parseGroupField } from "./groups.ts";
import { messageSnippet, snoozeChoice } from "./logic.ts";
import { messagesFromMailFile, splitMbox } from "./import-mail.ts";

test("contact groups are trimmed, de-duplicated and capped", () => {
  assert.deepEqual(cleanGroups([" Friends ", "friends", "", "Family"]), ["Friends", "Family"]);
  assert.equal(cleanGroups(["a", "b", "c", "d", "e", "f", "g", "h", "i"]).length, 8);
  assert.deepEqual(parseGroupField("Work, Work, Home"), ["Work", "Home"]);
});

test("a snooze lands on the next morning, Saturday, or a week ahead", () => {
  const wednesday = new Date("2026-11-18T22:00:00.000Z");
  assert.equal(snoozeChoice("tomorrow", wednesday), "2026-11-19T08:00:00.000Z");
  assert.equal(snoozeChoice("weekend", wednesday), "2026-11-21T08:00:00.000Z");
  assert.equal(snoozeChoice("next-week", wednesday), "2026-11-25T08:00:00.000Z");
  assert.equal(snoozeChoice("weekend", new Date("2026-11-21T09:00:00.000Z")), "2026-11-28T08:00:00.000Z");
});

test("armored mail does not put its body in the preview", () => {
  assert.equal(messageSnippet("-----BEGIN PGP MESSAGE-----\narmor\n-----END PGP MESSAGE-----"), "Encrypted message");
  assert.equal(messageSnippet("Hello\nthere"), "Hello there");
});

test("eml and mbox become inbox messages without dropping a second message", async () => {
  const eml = ["From: Ada <ada@example.com>", "To: Bea <bea@example.com>", "Subject: Hello", "Date: Tue, 10 Nov 2026 12:00:00 +0000", "Content-Type: text/plain; charset=utf-8", "", "Hello Bea"].join("\r\n");
  const [one] = await messagesFromMailFile(eml, "2026-11-19T00:00:00.000Z");
  assert.equal(one?.subject, "Hello");
  assert.equal(one?.from.email, "ada@example.com");
  assert.equal(one?.body.includes("Hello Bea"), true);
  assert.equal(one?.folder, "inbox");
  const mbox = `From ada@example.com Tue Nov 10 12:00:00 2026\n${eml}\n\nFrom ada@example.com Tue Nov 10 13:00:00 2026\nFrom: Ada <ada@example.com>\nTo: Bea <bea@example.com>\nSubject: Second\n\nAgain\n`;
  assert.equal(splitMbox(mbox).length, 2);
  const both = await messagesFromMailFile(mbox, "2026-11-19T00:00:00.000Z");
  assert.equal(both.length, 2);
  assert.equal(both[1]?.subject, "Second");
  const again = await messagesFromMailFile(eml, "2026-11-19T00:00:00.000Z");
  assert.equal(again[0]?.id, one?.id);
});
