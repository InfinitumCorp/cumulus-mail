import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import pg from "pg";

const script = new URL("./migrate.mjs", import.meta.url).pathname;
const run = (env, args = ["--status"]) =>
  spawnSync(process.execPath, [script, ...args], { env: { ...process.env, ...env }, encoding: "utf8" });

test("--status without DATABASE_URL skips and exits 0", () => {
  const result = run({ DATABASE_URL: "" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /skipping/);
});

// Needs a throwaway Postgres: TEST_DATABASE_URL=postgres://... (the database is reset).
const url = process.env.TEST_DATABASE_URL;
test("--status is read-only, lists pending, exits 3 until migrated, then 0", { skip: !url && "TEST_DATABASE_URL not set" }, async () => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("drop schema public cascade; create schema public;");
    const before = run({ DATABASE_URL: url });
    assert.equal(before.status, 3, before.stderr);
    assert.match(before.stdout, /pending 0001_/);
    const table = await client.query("select to_regclass('_migrations') as t");
    assert.equal(table.rows[0].t, null, "--status must not create _migrations");
    assert.equal(run({ DATABASE_URL: url }, []).status, 0);
    const after = run({ DATABASE_URL: url });
    assert.equal(after.status, 0, after.stderr);
    assert.match(after.stdout, /up to date/);
  } finally {
    await client.end();
  }
});
