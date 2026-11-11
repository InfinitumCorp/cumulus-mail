import assert from "node:assert/strict";
import { test } from "node:test";
import { hyperdriveConnectionString, isWorkersRuntime, workerEnv } from "./runtime.ts";

const holder = globalThis as typeof globalThis & { __env__?: Record<string, unknown> };

function withWorkerEnv<T>(env: Record<string, unknown> | undefined, run: () => T): T {
  const previous = holder.__env__;
  if (env === undefined) delete holder.__env__;
  else holder.__env__ = env;
  try {
    return run();
  } finally {
    if (previous === undefined) delete holder.__env__;
    else holder.__env__ = previous;
  }
}

test("Node is not the Workers runtime", () => {
  assert.equal(isWorkersRuntime(), false);
});

test("there is no Worker env under Node", () => {
  withWorkerEnv(undefined, () => {
    assert.equal(workerEnv(), undefined);
    assert.equal(hyperdriveConnectionString(), undefined);
  });
});

test("a Hyperdrive binding hands over its connection string", () => {
  withWorkerEnv({ MAIL_DB: { connectionString: "postgresql://user@hyperdrive.local/postgres" } }, () => {
    assert.equal(hyperdriveConnectionString(), "postgresql://user@hyperdrive.local/postgres");
    assert.equal(hyperdriveConnectionString("OTHER_DB"), undefined);
  });
  withWorkerEnv({ OTHER_DB: { connectionString: "postgresql://user@other/postgres" } }, () => {
    assert.equal(hyperdriveConnectionString("OTHER_DB"), "postgresql://user@other/postgres");
  });
});

test("a binding that is not a Hyperdrive is ignored, not mistaken for one", () => {
  // A var, a blank string and an object without the field all mean "no database".
  withWorkerEnv({ MAIL_DB: "postgresql://not-a-binding/postgres" }, () => {
    assert.equal(hyperdriveConnectionString(), undefined);
  });
  withWorkerEnv({ MAIL_DB: { connectionString: "   " } }, () => {
    assert.equal(hyperdriveConnectionString(), undefined);
  });
  withWorkerEnv({ MAIL_DB: { host: "hyperdrive.local" } }, () => {
    assert.equal(hyperdriveConnectionString(), undefined);
  });
});
