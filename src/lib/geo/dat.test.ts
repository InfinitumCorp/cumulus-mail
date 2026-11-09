import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DomainType,
  cidrContains,
  decodeGeoIPList,
  decodeGeoSiteList,
  lookupCategories,
  lookupCountry,
  parseIp,
} from "./dat.ts";
import {
  cidr,
  domainRule,
  geoipEntry,
  geoipList,
  geositeEntry,
  geositeList,
  skippedFixed32,
} from "./fixture.ts";

const geoip = decodeGeoIPList(
  geoipList([
    geoipEntry("ZZ", [cidr([203, 0, 113, 0], 24)]),
    geoipEntry("V6", [cidr([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 32)]),
    geoipEntry("OUT", [cidr([10, 0, 0, 0], 8)], true),
  ]),
);

const geosite = decodeGeoSiteList(
  geositeList([
    geositeEntry("example", [
      domainRule(DomainType.Full, "mail.example.test"),
      domainRule(DomainType.Domain, "example.test"),
      domainRule(DomainType.Plain, "keyword", skippedFixed32(9)),
    ]),
    geositeEntry("pattern", [domainRule(DomainType.Regex, "^re\\.example\\.test$")]),
    geositeEntry("plain-default", [domainRule(0, "notice")]),
  ]),
);

test("an address maps to the first matching country", () => {
  assert.equal(lookupCountry(geoip, "203.0.113.9"), "ZZ");
  assert.equal(lookupCountry(geoip, "203.0.113.255"), "ZZ");
  assert.equal(lookupCountry(geoip, "203.0.114.1"), "OUT");
  assert.equal(lookupCountry(geoip, "198.51.100.1"), "OUT");
  assert.equal(lookupCountry(geoip, "10.1.2.3"), null);
  assert.equal(lookupCountry(geoip, "::ffff:203.0.113.9"), "ZZ");
  assert.equal(lookupCountry(geoip, "2001:db8::1"), "V6");
  assert.equal(lookupCountry(geoip, "2001:db9::1"), "OUT");
  assert.equal(lookupCountry(geoip, "not-an-ip"), null);
});

test("a domain maps to every matching category", () => {
  assert.deepEqual(lookupCategories(geosite, "mail.example.test"), ["example"]);
  assert.deepEqual(lookupCategories(geosite, "a.example.test"), ["example"]);
  assert.deepEqual(lookupCategories(geosite, "notexample.test"), []);
  assert.deepEqual(lookupCategories(geosite, "has-keyword.test"), ["example"]);
  assert.deepEqual(lookupCategories(geosite, "Re.example.test"), ["example", "pattern"]);
  assert.deepEqual(lookupCategories(geosite, "ada@notice.example"), ["plain-default"]);
  assert.deepEqual(lookupCategories(geosite, "Mail.Example.Test."), ["example"]);
});

test("CIDR bit boundaries and a truncated payload fail closed", () => {
  const parsed = parseIp("203.0.113.0");
  assert.ok(parsed);
  assert.equal(cidrContains({ ip: Uint8Array.from([203, 0, 113, 0]), prefix: 24 }, parsed), true);
  assert.equal(
    cidrContains({ ip: Uint8Array.from([203, 0, 113, 0]), prefix: 25 }, parseIp("203.0.113.128")!),
    false,
  );
  assert.throws(() => decodeGeoIPList(Uint8Array.from([0x0a, 0x05, 0x0a])), /truncated/);
});
