import assert from "node:assert/strict";
import { test } from "node:test";
import { generateRecoveryCodes, generateTotpSecret, otpauthUri, recoveryHash, recoveryMatches, totpCode, verifyTotpCode } from "./totp.ts";

test("totp accepts the current code and one step either side, and rejects another", () => {
  const secret = generateTotpSecret();
  const now = Date.parse("2026-11-19T12:00:00.000Z");
  assert.equal(verifyTotpCode(secret, totpCode(secret, now), now), true);
  assert.equal(verifyTotpCode(secret, totpCode(secret, now - 30_000), now), true);
  assert.equal(verifyTotpCode(secret, totpCode(secret, now + 90_000), now), false);
  assert.equal(verifyTotpCode(secret, "000000", now), false);
  assert.equal(verifyTotpCode(secret, "abcdef", now), false);
  assert.match(otpauthUri("ada@cumuluscloud.app", secret), /^otpauth:\/\/totp\//);
  assert.match(otpauthUri("ada@cumuluscloud.app", secret), new RegExp(`secret=${secret}`));
});

test("a recovery code matches once, as a hash", () => {
  const [code] = generateRecoveryCodes(2);
  assert.equal(code!.length, 10);
  const hashes = [recoveryHash(code!), recoveryHash("OTHERCODE1")];
  assert.equal(recoveryMatches(hashes, code!.toLowerCase()), 0);
  assert.equal(recoveryMatches(hashes, "nope"), -1);
  assert.equal(hashes[0]!.includes(code!), false);
});
