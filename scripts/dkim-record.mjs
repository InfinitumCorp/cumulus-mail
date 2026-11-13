#!/usr/bin/env node
/**
 * `npm run dkim:record -- <key.pem> [selector] [domain]`: print the DKIM TXT record to publish for a
 * signing key, already split into DNS strings of at most 255 characters (a 2048-bit key does not fit in
 * one). Reads only the public half. The key file itself never leaves the machine.
 */
import { readFileSync } from "node:fs";
const { dkimDnsRecord } = await import("../src/lib/mail/outbound/dkim.ts");

const [path, selector = "<selector>", domain = "cumuluscloud.app"] = process.argv.slice(2);
if (!path) {
  console.error("Usage: npm run dkim:record -- <key.pem> [selector] [domain]");
  process.exit(1);
}
const record = dkimDnsRecord(readFileSync(path, "utf8"));
const parts = record.match(/.{1,255}/g) ?? [];
console.log(`Name:  ${selector}._domainkey.${domain}`);
console.log("Type:  TXT");
console.log(`Value: ${parts.map((p) => `"${p}"`).join(" ")}`);
