import assert from "node:assert/strict";
import { test } from "node:test";
import { DomainType } from "./dat.ts";
import { cidr, domainRule, geoipEntry, geoipList, geositeEntry, geositeList } from "./fixture.ts";
import { decodeGeoIPList, decodeGeoSiteList } from "./dat.ts";
import { applyGeoPolicy, infinitumGeoEnabled, mailboxGeoEnabled } from "./policy.ts";
import { SEED_MESSAGES, type MailMessage } from "../mail/model.ts";

const message: MailMessage = { ...SEED_MESSAGES[0]!, labels: ["Spectre"] };
const geoip = decodeGeoIPList(geoipList([geoipEntry("ZZ", [cidr([203, 0, 113, 0], 24)])]));
const geosite = decodeGeoSiteList(
  geositeList([geositeEntry("example", [domainRule(DomainType.Domain, "example.test")])]),
);

test("the server switch and the mailbox switch default off", () => {
  assert.equal(infinitumGeoEnabled({}), false);
  assert.equal(infinitumGeoEnabled({ INFINITUM_GEO_ENABLED: "" }), false);
  assert.equal(infinitumGeoEnabled({ INFINITUM_GEO_ENABLED: "false" }), false);
  assert.equal(infinitumGeoEnabled({ INFINITUM_GEO_ENABLED: "0" }), false);
  assert.equal(infinitumGeoEnabled({ INFINITUM_GEO_ENABLED: "true" }), true);
  assert.equal(infinitumGeoEnabled({ INFINITUM_GEO_ENABLED: "on" }), true);
  assert.equal(mailboxGeoEnabled(undefined), false);
  assert.equal(mailboxGeoEnabled(false), false);
  assert.equal(mailboxGeoEnabled(true), true);
});

test("geo policy leaves the message untouched unless both switches are on", () => {
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  const input = { ip: "203.0.113.9", domain: "ada@mail.example.test", geoip, geosite, log };
  assert.equal(
    applyGeoPolicy(message, { ...input, envEnabled: false, userEnabled: true }),
    message,
  );
  assert.equal(
    applyGeoPolicy(message, { ...input, envEnabled: true, userEnabled: false }),
    message,
  );
  assert.deepEqual(logs, []);

  const annotated = applyGeoPolicy(message, { ...input, envEnabled: true, userEnabled: true });
  assert.notEqual(annotated, message);
  assert.deepEqual(annotated.labels, ["Spectre", "geo:ZZ", "site:example"]);
  assert.equal(annotated.folder, message.folder);
  assert.equal(annotated.body, message.body);
  assert.equal(annotated.auth, message.auth);
  assert.deepEqual(logs, ["geo route country=ZZ categories=example"]);

  const again = applyGeoPolicy(annotated, { ...input, envEnabled: true, userEnabled: true });
  assert.equal(again, annotated);
});
