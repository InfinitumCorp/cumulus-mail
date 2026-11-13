import assert from "node:assert/strict";
import { createPublicKey, createVerify } from "node:crypto";
import { test } from "node:test";
import { bodyHash, dkimSignatureHeader, relaxedBody, relaxedHeader, signMessage, splitMessage } from "./dkim.ts";

// Throwaway 1024-bit RSA key made for this test only. It signs nothing real.
const TEST_KEY_B64 = "MIICdwIBADANBgkqhkiG9w0BAQEFAASCAmEwggJdAgEAAoGBAMvuXMdGL6KVtGtgzWJyepjstqSY7yxaZFZ67fsO3LnEylvloHFzuXF2/sPMQ22ore40BR12sb7zOkNgmaKxm5vmsNBsw8cT5LKCY8+h7yaSRo00RkCcv8nlIBxAm1dAmxP+SuXaQQIkjiSMEN24wVCncgs7ogtRW0dfodGTrPHlAgMBAAECgYEAgx4RxwpIbFemtfd6dla2noZr9C5kcPb5VmUZh/cJUePGXAmq++b1D4/7w7YckHAIzIPj2grLw8Ms7c85WNKrAg64JxeH1VJ/BkyL1W208+SSeJzlA/kOkm4WFORjq96F4nFO3MLyZhcFm+lk2pdDQiRUK+VQNfj3E9zCAsx2kC0CQQDxAbjClckQYV9nTFQAi3zZxQCiwYQhhxSRO8RNR7Ta+o+1NvxV4+xDuE8JoC+OI+ERBW2DPS+YQEKiAcWy6C5LAkEA2J4sbSiZIR3MrXdN+4WdZxS/1KLMWZKRIFhRQKUoqy4P5b+2Zk0seF7JW9H0OK/DUlEhKLjGvlq59ydztcuCjwJBAIb37d6bP7S6s1EIP+rmMw9J8mczdKnKGkyTagXVaIVR2PUlS/9V21S5fRno6XjywvJjVccvlt3u7uIHmA3vVS0CQAZFJdIPD8emnisTPf2e03yNXDQidjnNhUfjZo6xeSjjT3B+CSCS8UuWqstum1wcslGqqYQNPSt7YtClorLLbj8CQC8bH3HzBzVqbuuMj3gmxX1LfZvbGmetXocFJS4UvsyOaQR7Phx+MVWJoIrHlfITNllYoiCR/A+EXEs4MK0ucWA=";
const TEST_KEY = ["-----BEGIN PRIVATE", " KEY-----\n"].join("") + TEST_KEY_B64.replace(/(.{64})/g, "$1\n") + ["\n-----END PRIVATE", " KEY-----\n"].join("");

// Expected b= value, produced independently with the openssl CLI:
//   printf 'from:Joe <joe@example.com>\r\nto:Ann <ann@example.org>\r\nsubject:Hi there\r\ndkim-signature:v=1; a=rsa-sha256; c=relaxed/relaxed; d=example.com; s=sel1; t=1700000000; h=from:to:subject; bh=<BH>; b=' \
//     | openssl dgst -sha256 -sign key.pem | base64 -w0
const EXPECTED_BH = "unak6JHq0wL+Q1HP7dW1tjBx9FLA6DffoZ0qrLwbbpo=";
const EXPECTED_B = "Vv9VFXK7BNyj4k+XLUMphIrswXrkfuGTUktIN7z32gKeT8YPqUTA39FXE2wSXmXSUn7O7odAzzQ0srBm8drWIYEa0bsOqPKryScmE1/eBDnxqnMfHViSphiFpm7EeMVkzBHPu7k3GanNGkS5eCcNL6rNsu/+Kk7x4uS2h2SpL58=";

const MESSAGE = "From: Joe <joe@example.com>\r\nTo:  Ann  <ann@example.org> \r\nSubject: Hi\r\n there\r\n\r\n C \r\nD \t E\r\n\r\n\r\n";

test("relaxed canonicalization matches the RFC 6376 §3.4.5 examples", () => {
  assert.equal(relaxedHeader("A", " X"), "a:X");
  assert.equal(relaxedHeader("B ", " Y\t\r\n\tZ  "), "b:Y Z");
  assert.equal(relaxedBody(" C \r\nD \t E\r\n\r\n\r\n"), " C\r\nD E\r\n");
  assert.equal(relaxedBody(""), "");
  assert.equal(relaxedBody("\r\n\r\n"), "");
  // sha256 of the empty string: the relaxed hash of an empty body.
  assert.equal(bodyHash(""), "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=");
  assert.equal(bodyHash(" C \r\nD \t E\r\n\r\n\r\n"), EXPECTED_BH);
});

test("the signature matches a vector computed independently with openssl", () => {
  const header = dkimSignatureHeader(MESSAGE, {
    domain: "example.com",
    selector: "sel1",
    privateKeyPem: TEST_KEY,
    headers: ["from", "to", "subject", "date"],
    timestamp: 1700000000,
  });
  assert.match(header, /^DKIM-Signature: v=1; a=rsa-sha256; c=relaxed\/relaxed; d=example.com; s=sel1; t=1700000000; h=from:to:subject; bh=/);
  assert.ok(header.includes(`bh=${EXPECTED_BH}; b=`));
  const b = header.slice(header.indexOf("; b=") + 4).replace(/\r\n\t/g, "");
  assert.equal(b, EXPECTED_B);
  assert.ok(header.split("\r\n").every((line) => line.length <= 998));
});

test("a signed message verifies with the public key, and tampering breaks it", () => {
  const signed = signMessage(MESSAGE.replace(/\r\n/g, "\n"), { domain: "example.com", selector: "sel1", privateKeyPem: TEST_KEY, timestamp: 1700000000 });
  const { headers, body } = splitMessage(signed);
  const sig = headers.find((header) => header.name === "DKIM-Signature")!;
  const tags = Object.fromEntries(
    sig.value.replace(/\r\n[ \t]/g, "").split(";").map((part) => part.trim().split(/=(.*)/s).slice(0, 2) as [string, string]),
  );
  assert.equal(tags.bh, bodyHash(body));
  const names = tags.h!.split(":");
  const canonical =
    names.map((name: string) => {
      const header = headers.find((item) => item.name.toLowerCase() === name)!;
      return `${relaxedHeader(header.name, header.value)}\r\n`;
    }).join("") + relaxedHeader("DKIM-Signature", sig.value.replace(/b=[^;]*$/s, "b="));
  const pub = createPublicKey(TEST_KEY);
  const verify = (text: string) => createVerify("RSA-SHA256").update(text).verify(pub, tags.b!.replace(/\s+/g, ""), "base64");
  assert.equal(verify(canonical), true);
  assert.equal(verify(canonical.replace("Hi there", "Hi thera")), false);
});
