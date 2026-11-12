import assert from "node:assert/strict";
import { test } from "node:test";
import { nextTrapTarget } from "./focus.ts";

test("Tab wraps inside a dialog in both directions and leaves the middle to the browser", () => {
  const items = ["close", "name", "save"];
  assert.equal(nextTrapTarget(items, "save", false), "close");
  assert.equal(nextTrapTarget(items, "close", true), "save");
  assert.equal(nextTrapTarget(items, "name", false), null);
  assert.equal(nextTrapTarget(items, "name", true), null);
  // Focus outside the dialog is pulled back in.
  assert.equal(nextTrapTarget(items, null, false), "close");
  assert.equal(nextTrapTarget(items, "elsewhere", true), "save");
  assert.equal(nextTrapTarget([], null, false), null);
  assert.equal(nextTrapTarget(["only"], "only", false), "only");
});
