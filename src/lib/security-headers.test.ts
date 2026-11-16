import assert from "node:assert/strict";
import { test } from "node:test";
import { HSTS, applySecurityHeaders, isHttps } from "./security-headers.ts";

test("https is read from the proxy header first, then the URL", () => {
  assert.equal(isHttps("http://10.0.0.1:8080/", "https"), true);
  assert.equal(isHttps("http://10.0.0.1:8080/", "https, http"), true);
  assert.equal(isHttps("https://mail.cumuluscloud.app/", "http"), false);
  assert.equal(isHttps("https://mail.cumuluscloud.app/", null), true);
  assert.equal(isHttps("http://localhost:8080/", undefined), false);
});

test("safe headers everywhere, HSTS only on https, and a route's own value wins", () => {
  const plain = applySecurityHeaders(new Headers(), false);
  assert.equal(plain.get("x-content-type-options"), "nosniff");
  assert.equal(plain.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.match(plain.get("permissions-policy") ?? "", /camera=\(\)/);
  assert.equal(plain.has("strict-transport-security"), false);
  // No framing rules: the app runs inside the preview iframe.
  assert.equal(plain.has("x-frame-options"), false);
  assert.equal(plain.has("content-security-policy"), false);

  assert.equal(applySecurityHeaders(new Headers(), true).get("strict-transport-security"), HSTS);
  const own = applySecurityHeaders(new Headers({ "referrer-policy": "no-referrer" }), true);
  assert.equal(own.get("referrer-policy"), "no-referrer");
});
