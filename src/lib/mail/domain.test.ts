import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { DEFAULT_MAIL_APP_HOST, DEFAULT_MAIL_DOMAIN, mailAppHost, mailDomain, mailboxAddress } from "./domain.ts";
import { isCumulus } from "./logic.ts";

const previous = {
  domain: process.env.MAIL_DOMAIN,
  host: process.env.MAIL_APP_HOST,
};

afterEach(() => {
  if (previous.domain === undefined) delete process.env.MAIL_DOMAIN;
  else process.env.MAIL_DOMAIN = previous.domain;
  if (previous.host === undefined) delete process.env.MAIL_APP_HOST;
  else process.env.MAIL_APP_HOST = previous.host;
});

test("the default domain and app host are the Cloudflare names", () => {
  delete process.env.MAIL_DOMAIN;
  delete process.env.MAIL_APP_HOST;
  assert.equal(DEFAULT_MAIL_DOMAIN, "cumuluscloud.app");
  assert.equal(DEFAULT_MAIL_APP_HOST, "mail.cumuluscloud.app");
  assert.equal(mailDomain(), "cumuluscloud.app");
  assert.equal(mailAppHost(), "mail.cumuluscloud.app");
  assert.equal(mailboxAddress("alex"), "alex@cumuluscloud.app");
  assert.equal(isCumulus("Leah@cumuluscloud.app"), true);
  assert.equal(isCumulus("priya@vyral.london"), false);
});

test("MAIL_DOMAIN and MAIL_APP_HOST override the defaults", () => {
  process.env.MAIL_DOMAIN = "example.test";
  process.env.MAIL_APP_HOST = "web.example.test";
  assert.equal(mailDomain(), "example.test");
  assert.equal(mailAppHost(), "web.example.test");
  assert.equal(isCumulus("a@example.test"), true);
  assert.equal(isCumulus("a@cumuluscloud.app"), false);
});
