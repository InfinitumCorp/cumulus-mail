import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DomainType,
  cidrMatches,
  decodeGeoIpList,
  decodeGeoSiteList,
  encodeGeoIpList,
  encodeGeoSiteList,
  lookupCategories,
  lookupCountry,
  parseIp,
  readFields,
} from "./dat.ts";
import { syntheticGeoDatasets, syntheticGeoFiles } from "./sample.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

test("protobuf round trip keeps countries, prefixes, and domain rules", () => {
  const data = syntheticGeoDatasets();
  const decodedIp = decodeGeoIpList(encodeGeoIpList(data.ip));
  assert.equal(decodedIp.length, data.ip.length);
  assert.equal(decodedIp[1]?.countryCode, "US");
  assert.equal(decodedIp[1]?.cidrs[0]?.prefix, 24);
  assert.deepEqual(decodedIp[1]?.cidrs[0]?.ip, Uint8Array.of(192, 0, 2, 0));
  assert.equal(decodedIp[1]?.cidrs[1]?.prefix, 32);
  assert.equal(decodedIp[3]?.reverseMatch, true);

  const decodedSite = decodeGeoSiteList(encodeGeoSiteList(data.site));
  assert.deepEqual(
    decodedSite.map((entry) => entry.code),
    ["category-ads", "google", "cumulus"],
  );
  assert.equal(decodedSite[0]?.domains[1]?.type, DomainType.Full);
  assert.equal(decodedSite[0]?.domains[3]?.value, "^bad\\.");
});

test("an attribute on a domain rule is ignored", () => {
  const { geosite } = syntheticGeoFiles();
  const decoded = decodeGeoSiteList(geosite);
  assert.equal(decoded[0]?.domains[3]?.value, "^bad\\.");
  assert.equal(decoded[0]?.domains.length, 4);
});

test("synthetic fixture files decode to the same lists", () => {
  const ip = decodeGeoIpList(readFileSync(join(fixtures, "geoip.dat")));
  const site = decodeGeoSiteList(readFileSync(join(fixtures, "geosite.dat")));
  const expected = syntheticGeoDatasets();
  assert.equal(ip.length, expected.ip.length);
  assert.deepEqual(
    ip.map((entry) => ({
      countryCode: entry.countryCode,
      reverseMatch: entry.reverseMatch,
      cidrs: entry.cidrs.map((cidr) => ({ prefix: cidr.prefix, ip: [...cidr.ip] })),
    })),
    expected.ip.map((entry) => ({
      countryCode: entry.countryCode,
      reverseMatch: entry.reverseMatch,
      cidrs: entry.cidrs.map((cidr) => ({ prefix: cidr.prefix, ip: [...cidr.ip] })),
    })),
  );
  assert.deepEqual(
    site.map((entry) => ({ code: entry.code, domains: entry.domains })),
    expected.site.map((entry) => ({ code: entry.code, domains: entry.domains })),
  );
  assert.ok(readFileSync(join(fixtures, "geoip.dat")).byteLength < 4096);
  assert.ok(readFileSync(join(fixtures, "geosite.dat")).byteLength < 4096);
});

test("IP lookup returns a country, a private list, or nothing", () => {
  const { ip } = syntheticGeoDatasets();
  assert.equal(lookupCountry(ip, "192.0.2.10"), "US");
  assert.equal(lookupCountry(ip, "192.0.2.255"), "US");
  assert.equal(lookupCountry(ip, "192.0.3.1"), "TEST");
  assert.equal(lookupCountry(ip, "203.0.113.9"), "CN");
  assert.equal(lookupCountry(ip, "10.1.2.3"), "PRIVATE");
  assert.equal(lookupCountry(ip, "2001:db8::1"), "US");
  assert.equal(lookupCountry(ip, "::ffff:192.0.2.10"), "US");
  assert.equal(lookupCountry(ip, "198.51.100.10"), null);
  assert.equal(lookupCountry(ip, "not-an-ip"), null);
  assert.equal(lookupCountry(ip, "999.1.1.1"), null);
  assert.equal(lookupCountry(ip, "192.0.2.10%eth0"), "US");
  assert.equal(parseIp("::1")?.length, 16);
  assert.equal(
    cidrMatches(Uint8Array.of(1, 2, 3, 4), { ip: Uint8Array.of(1, 2, 3, 0), prefix: 24 }),
    true,
  );
  assert.equal(
    cidrMatches(Uint8Array.of(1, 2, 4, 4), { ip: Uint8Array.of(1, 2, 3, 0), prefix: 24 }),
    false,
  );
});

test("domain lookup returns every matching category", () => {
  const { site } = syntheticGeoDatasets();
  assert.deepEqual(lookupCategories(site, "ads.example"), ["category-ads"]);
  assert.deepEqual(lookupCategories(site, "Sub.Ads.Example."), ["category-ads"]);
  assert.deepEqual(lookupCategories(site, "notads.example"), []);
  assert.deepEqual(lookupCategories(site, "tracker.test"), ["category-ads"]);
  assert.deepEqual(lookupCategories(site, "a.tracker.test"), []);
  assert.deepEqual(lookupCategories(site, "pixel.doubleclick.net"), ["category-ads"]);
  assert.deepEqual(lookupCategories(site, "bad.example"), ["category-ads"]);
  assert.deepEqual(lookupCategories(site, "mail.google.com"), ["google"]);
  assert.deepEqual(lookupCategories(site, "google.com"), ["google"]);
  assert.deepEqual(lookupCategories(site, "notgoogle.com"), []);
  assert.deepEqual(lookupCategories(site, "Mira.Chen@CumulusCloud.App"), []);
  assert.deepEqual(lookupCategories(site, "cumuluscloud.app"), ["cumulus"]);
});

test("a broken or oversized regexp does not match", () => {
  const site = [
    {
      code: "broken",
      domains: [
        { type: DomainType.Regex, value: "[" },
        { type: DomainType.Regex, value: "a".repeat(201) },
      ],
    },
  ];
  assert.deepEqual(lookupCategories(site, "a.example"), []);
});

test("truncated protobuf is rejected", () => {
  assert.throws(() => readFields(Uint8Array.of(0x0a, 0x05, 0x01)), /truncated protobuf/);
  assert.throws(() => decodeGeoIpList(Uint8Array.of(0x0b)), /unsupported protobuf wire type/);
});

test("fixed-width fields are skipped", () => {
  const fields = readFields(Uint8Array.of(0x0d, 1, 2, 3, 4, 0x0a, 0x02, 0x55, 0x53));
  assert.deepEqual(
    fields.map((field) => field.field),
    [1],
  );
  assert.equal(fields[0]?.wire, 2);
});
