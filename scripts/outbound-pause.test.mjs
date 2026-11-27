import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePauseArgs } from "./outbound-pause.mjs";

test("outbound:pause arguments", () => {
  assert.deepEqual(parsePauseArgs(["--list"]), { action: "list" });
  assert.match(parsePauseArgs([]).error, /--address/);
  assert.deepEqual(parsePauseArgs(["--address", "A@Cumuluscloud.app", "--resume"]), { action: "resume", address: "a@cumuluscloud.app", tenant: "" });
  assert.deepEqual(parsePauseArgs(["--tenant", "t1"]), { action: "pause", address: "", tenant: "t1", hours: 72, reason: "" });
  assert.equal(parsePauseArgs(["--tenant", "t1", "--hours", "6", "--reason", "spam"]).hours, 6);
  assert.match(parsePauseArgs(["--tenant", "t1", "--hours", "-1"]).error, /--hours/);
  assert.match(parsePauseArgs(["--address", "--resume"]).error, /--address/, "a flag is not an address");
});
