import assert from "node:assert/strict";
import { test } from "node:test";
import { levelFor, requestId, requestLine, requestLogEnabled, scrubPath, writeRequestLine } from "./request-log.ts";

test("logging is off unless MAIL_REQUEST_LOG=on", () => {
  assert.equal(requestLogEnabled({}), false);
  assert.equal(requestLogEnabled({ MAIL_REQUEST_LOG: "true" }), false);
  assert.equal(requestLogEnabled({ MAIL_REQUEST_LOG: " ON " }), true);
});

test("the path is scrubbed: no query string, no token, no address", () => {
  assert.equal(scrubPath("/api/health?deep=1"), "/api/health");
  assert.equal(scrubPath("/p/8f3c1d2e9b7a4c5d6e0f1a2b3c4d5e6f"), "/p/:id");
  assert.equal(scrubPath("/api/mail/u/alex@cumuluscloud.app"), "/api/mail/u/:addr");
  assert.equal(scrubPath("/api/messages/12345"), "/api/messages/:id");
  assert.equal(scrubPath("/api/auth/sign-in/social"), "/api/auth/sign-in/social");
  assert.equal(scrubPath("/"), "/");
  assert.equal(scrubPath("/x".repeat(400)).length <= 200, true);
});

test("the request id comes from the proxy when it is plain, else a fresh one", () => {
  const headers = (map: Record<string, string>) => ({ get: (name: string) => map[name] ?? null });
  assert.equal(requestId(headers({ "cf-ray": "8f3c1d2e9b7a4c5d-DME" })), "8f3c1d2e9b7a4c5d-DME");
  assert.equal(requestId(headers({ "apigw-requestid": "abc123def456" })), "abc123def456");
  // A caller-controlled header is not copied into the logs unchecked.
  assert.equal(requestId(headers({ "x-request-id": "<script>alert(1)</script>" }), () => "generated"), "generated");
  assert.equal(requestId(headers({ "x-request-id": "short" }), () => "generated"), "generated");
  assert.equal(requestId(headers({}), () => "generated"), "generated");
});

test("a line carries no body, query, address or IP, and the level follows the status", () => {
  const line = requestLine({
    id: "req-1",
    method: "post",
    path: "/p/8f3c1d2e9b7a4c5d6e0f1a2b3c4d5e6f?key=secret",
    status: 500,
    ms: 12.6,
    region: "ru",
    commit: "9cf6fc9",
    now: new Date("2026-11-13T10:00:00Z"),
  });
  assert.deepEqual(line, {
    t: "2026-11-13T10:00:00.000Z",
    level: "error",
    msg: "request",
    id: "req-1",
    method: "POST",
    path: "/p/:id",
    status: 500,
    ms: 13,
    region: "ru",
    commit: "9cf6fc9",
  });
  const text = JSON.stringify(line);
  assert.equal(/secret|8f3c1d2e/.test(text), false);
  assert.equal(levelFor(200), "info");
  assert.equal(levelFor(404), "warn");
  assert.equal(levelFor(503), "error");
});

test("a line is written as one JSON object per call", () => {
  const out: string[] = [];
  writeRequestLine(requestLine({ id: "a", method: "GET", path: "/", status: 200, ms: 1, region: "us", commit: "x" }), (text) => out.push(text));
  assert.equal(out.length, 1);
  assert.equal(out[0]!.includes("\n"), false);
  assert.equal(JSON.parse(out[0]!).msg, "request");
});

test("scrubbing errs towards replacing: a long slug goes too, rather than a token staying", () => {
  assert.equal(scrubPath("/nope-does-not-exist"), "/:id");
  assert.equal(scrubPath("/api/health"), "/api/health");
});
