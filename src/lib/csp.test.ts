import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCsp, cspHeaderName, cspMode, GROK_EXTENSIONS_URL, newNonce } from "./csp.ts";

const directive = (csp: string, name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `))?.slice(name.length + 1).split(" ") ?? [];

test("MAIL_CSP stages the policy: enforce by default in production, off in development", () => {
  assert.equal(cspMode({}, true), "enforce");
  assert.equal(cspMode({}, false), "off");
  assert.equal(cspMode({ MAIL_CSP: " Report-Only " }, true), "report-only");
  assert.equal(cspMode({ MAIL_CSP: "enforce" }, false), "enforce");
  assert.equal(cspMode({ MAIL_CSP: "off" }, true), "off");
  assert.equal(cspMode({ MAIL_CSP: "bogus" }, true), "enforce", "an unknown value never turns it off");
  assert.equal(cspHeaderName("enforce"), "content-security-policy");
  assert.equal(cspHeaderName("report-only"), "content-security-policy-report-only");
});

test("scripts: this origin and this response's nonce only; no unsafe-inline, no eval, no third party", () => {
  const csp = buildCsp({ nonce: "abc123" });
  assert.deepEqual(directive(csp, "script-src"), ["'self'", "'nonce-abc123'"]);
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.doesNotMatch(directive(csp, "script-src").join(" "), /unsafe-inline/);
  assert.doesNotMatch(csp, /https?:\/\//, "no third-party origin anywhere");
  assert.deepEqual(directive(csp, "frame-ancestors"), ["'none'"]);
  assert.deepEqual(directive(csp, "object-src"), ["'none'"]);
  assert.deepEqual(directive(csp, "base-uri"), ["'self'"]);
  assert.deepEqual(directive(csp, "connect-src"), ["'self'"]);
});

test("with the platform extensions on, exactly that one script URL is added, nothing else on its host", () => {
  const csp = buildCsp({ nonce: "n", extensionsScript: true });
  assert.deepEqual(directive(csp, "script-src"), ["'self'", "'nonce-n'", GROK_EXTENSIONS_URL]);
  assert.equal(csp.split("grok.com").length - 1, 1, "only in script-src, and only that path");
});

test("a nonce is fresh, 128 bits, and safe inside a CSP source expression", () => {
  const a = newNonce();
  const b = newNonce();
  assert.notEqual(a, b);
  assert.equal(Buffer.from(a, "base64").length, 16);
  assert.match(a, /^[A-Za-z0-9+/]+=*$/);
});
