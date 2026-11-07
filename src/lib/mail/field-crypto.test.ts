import assert from "node:assert/strict";
import { test } from "node:test";
import { blindIndex, openText, sealText } from "./field-crypto.ts";

if (!process.env.MAIL_BLOB_KEY) process.env.MAIL_BLOB_KEY = "ab".repeat(32);

test("message fields are AES-256-GCM and reject tampering and another tenant", () => {
  const sealed = sealText("tenant-a", "Quarterly review");
  assert.equal(sealed.includes("Quarterly"), false);
  assert.equal(openText("tenant-a", sealed), "Quarterly review");
  const flipped = `${sealed.slice(0, -1)}${sealed.endsWith("A") ? "B" : "A"}`;
  assert.throws(() => openText("tenant-a", flipped));
  assert.throws(() => openText("tenant-b", sealed));
  assert.notEqual(blindIndex("tenant-a", "subject", "Quarterly review"), blindIndex("tenant-b", "subject", "Quarterly review"));
  assert.equal(blindIndex(null, "address", "Ada@Example.test"), blindIndex(null, "address", "ada@example.test"));
});
