import assert from "node:assert/strict";
import { test } from "node:test";
import { cronDecision } from "./cron-auth.ts";

const SECRET = "c".repeat(40);

test("the cron endpoint is off unless a long CRON_SECRET is set", () => {
  assert.equal(cronDecision(`Bearer ${SECRET}`, {}), "off");
  assert.equal(cronDecision("Bearer short", { CRON_SECRET: "short" }), "off");
});

test("only the exact bearer token is allowed", () => {
  const env = { CRON_SECRET: SECRET };
  assert.equal(cronDecision(`Bearer ${SECRET}`, env), "allowed");
  assert.equal(cronDecision(`bearer ${SECRET}`, env), "allowed");
  assert.equal(cronDecision(`Bearer ${SECRET}x`, env), "denied");
  assert.equal(cronDecision(SECRET, env), "denied");
  assert.equal(cronDecision(null, env), "denied");
  assert.equal(cronDecision("Basic abc", env), "denied");
});
