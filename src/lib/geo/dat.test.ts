import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  encodeGeoIpList,
  encodeGeoSiteList,
  lookupCategories,
  lookupCountry,
  parseGeoIpList,
  parseGeoSiteList,
  parseIp,
  type GeoIpEntry,
} from "./dat.ts";

const ipFixture = new Uint8Array(readFileSync(new URL("./fixtures/geoip.dat", import.meta.url)));
const siteFixture = new Uint8Array(
  readFileSync(new URL("./fixtures/geosite.dat", import.meta.url)),
);

const ipEntries: GeoIpEntry[] = [
  { country: "US", reverse: false, cidrs: [{ ip: Uint8Array.from([1, 2, 3, 0]), prefix: 24 }] },
  { country: "PRIV", reverse: false, cidrs: [{ ip: Uint8Array.from([10, 0, 0, 0]), prefix: 8 }] },
  { country: "TN", reverse: false, cidrs: [{ ip: Uint8Array.from([192, 0, 2, 0]), prefix: 24 }] },
  { country: "V6", reverse: false, cidrs: [{ ip: parseIp("2001:db8::")!, prefix: 32 }] },
  { country: "REST", reverse: true, cidrs: [{ ip: Uint8Array.from([127, 0, 0, 0]), prefix: 8 }] },
];

const siteEntries = [
  { category: "cn", domains: [{ kind: "domain" as const, value: "example.cn" }] },
  { category: "ads", domains: [{ kind: "full" as const, value: "ads.example" }] },
  { category: "track", domains: [{ kind: "plain" as const, value: "track" }] },
  { category: "news", domains: [{ kind: "regex" as const, value: "^news\\." }] },
  { category: "mail", domains: [{ kind: "domain" as const, value: "cumuluscloud.app" }] },
];

test("synthetic geoip.dat matches the v2ray wire format and the lookup rules", () => {
  const hand = Uint8Array.from([
    0x0a, 0x0e, 0x0a, 0x02, 0x55, 0x53, 0x12, 0x08, 0x0a, 0x04, 0x01, 0x02, 0x03, 0x00, 0x10, 0x18,
  ]);
  assert.deepEqual(
    encodeGeoIpList([
      { country: "US", reverse: false, cidrs: [{ ip: Uint8Array.from([1, 2, 3, 0]), prefix: 24 }] },
    ]),
    hand,
  );
  assert.deepEqual(encodeGeoIpList(ipEntries), ipFixture);
  const list = parseGeoIpList(ipFixture);
  assert.equal(lookupCountry(list, "1.2.3.4"), "US");
  assert.equal(lookupCountry(list, "1.2.3.255"), "US");
  assert.equal(lookupCountry(list, "1.2.4.0"), "REST");
  assert.equal(lookupCountry(list, "10.1.2.3"), "PRIV");
  assert.equal(lookupCountry(list, "11.0.0.0"), "REST");
  assert.equal(lookupCountry(list, "192.0.2.10"), "TN");
  assert.equal(lookupCountry(list, "127.0.0.1"), null);
  assert.equal(lookupCountry(list, "2001:db8::1"), "V6");
  assert.equal(lookupCountry(list, "not-an-ip"), null);
  assert.equal(list.entries[4]?.reverse, true);
});

test("synthetic geosite.dat matches domain, full, plain, and regex rules", () => {
  const hand = Uint8Array.from([
    0x0a, 0x14, 0x0a, 0x02, 0x63, 0x6e, 0x12, 0x0e, 0x08, 0x02, 0x12, 0x0a, 0x65, 0x78, 0x61, 0x6d,
    0x70, 0x6c, 0x65, 0x2e, 0x63, 0x6e,
  ]);
  assert.deepEqual(
    encodeGeoSiteList([{ category: "cn", domains: [{ kind: "domain", value: "example.cn" }] }]),
    hand,
  );
  assert.deepEqual(encodeGeoSiteList(siteEntries), siteFixture);
  const list = parseGeoSiteList(siteFixture);
  assert.deepEqual(lookupCategories(list, "example.cn"), ["cn"]);
  assert.deepEqual(lookupCategories(list, "a.example.cn"), ["cn"]);
  assert.deepEqual(lookupCategories(list, "notexample.cn"), []);
  assert.deepEqual(lookupCategories(list, "ads.example"), ["ads"]);
  assert.deepEqual(lookupCategories(list, "www.ads.example"), []);
  assert.ok(lookupCategories(list, "tracker.example").includes("track"));
  assert.deepEqual(lookupCategories(list, "news.example"), ["news"]);
  assert.deepEqual(lookupCategories(list, "old.news.example"), []);
  assert.deepEqual(lookupCategories(list, "cumuluscloud.app"), ["mail"]);
  assert.deepEqual(lookupCategories(list, "mx.cumuluscloud.app."), ["mail"]);
});

test("a plain rule with the type field omitted still matches", () => {
  const bytes = Uint8Array.from([
    0x0a, 0x0c, 0x0a, 0x02, 0x70, 0x78, 0x12, 0x06, 0x12, 0x04, 0x74, 0x65, 0x73, 0x74,
  ]);
  const list = parseGeoSiteList(bytes);
  assert.deepEqual(lookupCategories(list, "mytest.host"), ["px"]);
  assert.deepEqual(lookupCategories(list, "example.cn"), []);
});

test("an unknown protobuf field does not hide the country", () => {
  const withExtra = Uint8Array.from([
    0x0a, 0x10, 0x0a, 0x02, 0x55, 0x53, 0x78, 0x01, 0x12, 0x08, 0x0a, 0x04, 0x01, 0x02, 0x03, 0x00,
    0x10, 0x18,
  ]);
  assert.equal(lookupCountry(parseGeoIpList(withExtra), "1.2.3.9"), "US");
});

test("a broken varint is rejected", () => {
  assert.throws(() => parseGeoIpList(Uint8Array.from([0x0a, 0x80])), /truncated/);
});
