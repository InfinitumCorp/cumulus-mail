import assert from "node:assert/strict";
import { test } from "node:test";
import { PREVIEW_BRIDGE_CHANNEL, readHostMessage } from "./preview-bridge-messages.ts";

const env = (fields: Record<string, unknown>) => ({ channel: PREVIEW_BRIDGE_CHANNEL, version: 1, ...fields });

test("host messages are read only in their exact shapes", () => {
  assert.deepEqual(readHostMessage(env({ type: "hello" })), { type: "hello" });
  assert.deepEqual(readHostMessage(env({ type: "connector-token-ready" })), { type: "connector-token-ready" });
  assert.deepEqual(readHostMessage(env({ type: "navigate", path: "/settings" })), { type: "navigate", path: "/settings" });
  assert.deepEqual(readHostMessage(env({ type: "history", delta: -1 })), { type: "history", delta: -1 });
  assert.deepEqual(readHostMessage(env({ type: "history", delta: 1 })), { type: "history", delta: 1 });

  assert.equal(readHostMessage(env({ type: "navigate", path: "" })), null);
  assert.equal(readHostMessage(env({ type: "navigate", path: 5 })), null);
  assert.equal(readHostMessage(env({ type: "history", delta: 2 })), null);
  assert.equal(readHostMessage(env({ type: "history", delta: "-1" })), null);
  assert.equal(readHostMessage(env({ type: "unknown" })), null);
  assert.equal(readHostMessage(env({ type: "" })), null);
  assert.equal(readHostMessage({ ...env({ type: "hello" }), channel: "other" }), null);
  assert.equal(readHostMessage({ ...env({ type: "hello" }), version: 0 }), null);
  assert.equal(readHostMessage({ ...env({ type: "hello" }), version: 1.5 }), null);
  assert.equal(readHostMessage(null), null);
  assert.equal(readHostMessage("hello"), null);
});
