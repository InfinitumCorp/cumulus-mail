import assert from "node:assert/strict";
import { test } from "node:test";
import { applyIndexing, hostName, indexableHosts, isIndexableHost, NOINDEX } from "./indexing.ts";

test("only the production names are indexable by default", () => {
  assert.equal(isIndexableHost("mail.cumuluscloud.app", ""), true);
  assert.equal(isIndexableHost("RU.mail.cumuluscloud.app:443", ""), true);
  assert.equal(isIndexableHost("mail.cumuluscloud.app.", ""), true);
  for (const host of [
    "cumulus-mail-api.example.workers.dev",
    "d5d1abc.apigw.yandexcloud.net",
    "bba1.containers.yandexcloud.net",
    "cumulus-mail-git-x.vercel.app",
    "localhost:3000",
    "127.0.0.1:8080",
    "[::1]:3000",
    "evil-mail.cumuluscloud.app.attacker.test",
    "",
    null,
  ]) {
    assert.equal(isIndexableHost(host, ""), false, String(host));
  }
});

test("INDEXABLE_HOSTS replaces the defaults; junk entries are ignored", () => {
  assert.deepEqual(indexableHosts(" Example.com , bad host,*.x.com, ,"), ["example.com"]);
  assert.deepEqual(indexableHosts("bad host"), ["mail.cumuluscloud.app", "ru.mail.cumuluscloud.app"]);
  assert.equal(isIndexableHost("example.com", "example.com"), true);
  assert.equal(isIndexableHost("mail.cumuluscloud.app", "example.com"), false);
});

test("hostName strips the port, a trailing dot and case", () => {
  assert.equal(hostName("Mail.CumulusCloud.app:443"), "mail.cumuluscloud.app");
  assert.equal(hostName("[::1]:3000"), "[::1]");
  assert.equal(hostName(undefined), "");
});

test("applyIndexing adds noindex off production and keeps a route's own value", () => {
  assert.equal(applyIndexing(new Headers(), "x.workers.dev", "").get("x-robots-tag"), NOINDEX);
  assert.equal(applyIndexing(new Headers(), "mail.cumuluscloud.app", "").get("x-robots-tag"), null);
  const own = new Headers({ "x-robots-tag": "noarchive" });
  assert.equal(applyIndexing(own, "x.workers.dev", "").get("x-robots-tag"), "noarchive");
});
