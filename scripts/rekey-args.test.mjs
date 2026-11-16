import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRekeyArgs } from "./rekey-args.mjs";

test("keys:rekey is a dry run unless --apply is given", () => {
  assert.deepEqual(parseRekeyArgs([]), { apply: false, batchSize: 50, fromTenant: undefined, help: false });
  assert.equal(parseRekeyArgs(["--apply"]).apply, true);
});

test("keys:rekey takes a batch size and a mailbox to resume after", () => {
  const options = parseRekeyArgs(["--batch", "10", "--from-tenant", "user_abc-1"]);
  assert.equal(options.batchSize, 10);
  assert.equal(options.fromTenant, "user_abc-1");
});

test("keys:rekey refuses bad or unknown options rather than guessing", () => {
  assert.throws(() => parseRekeyArgs(["--batch", "0"]), /1 to 1000/);
  assert.throws(() => parseRekeyArgs(["--batch"]), /needs a value/);
  assert.throws(() => parseRekeyArgs(["--from-tenant", "../x"]), /mailbox id/);
  assert.throws(() => parseRekeyArgs(["--aply"]), /Unknown option/);
});
