import assert from "node:assert/strict";
import { test } from "node:test";
import { signInErrorFromUrl, signInErrorKind } from "./sign-in-errors.ts";

test("sign-in errors become a kind the screen can explain in either language", () => {
  assert.equal(signInErrorKind(Object.assign(new Error("Too many requests. Please try again later."), { status: 429 })), "rate_limited");
  assert.equal(signInErrorKind(Object.assign(new Error("x"), { status: 429 })), "rate_limited");
  assert.equal(signInErrorKind(new Error("Pop-up blocked — allow pop-ups for sign-in")), "popup_blocked");
  assert.equal(signInErrorKind(new Error("Sign-in was cancelled or failed")), "cancelled");
  assert.equal(signInErrorKind(new TypeError("Failed to fetch")), "offline");
  assert.equal(signInErrorKind(new Error("internal_server_error")), "failed");
  assert.equal(signInErrorKind(undefined), "failed");
});

test("an ?error= coming back from Cumulus ID is recognised", () => {
  assert.equal(signInErrorFromUrl(""), null);
  assert.equal(signInErrorFromUrl("?lang=ru"), null);
  assert.equal(signInErrorFromUrl("?error=access_denied"), "cancelled");
  assert.equal(signInErrorFromUrl("?error=please_restart_the_process"), "provider");
  assert.equal(signInErrorFromUrl("?error=too_many_requests"), "rate_limited");
});
