import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPgConnectionString } from "./pg-connection.ts";

test("sslmode=disable is refused for any real database host", () => {
  for (const url of [
    "postgres://u:p@db.example:5432/postgres?sslmode=disable",
    "postgres://u:p@aws-0-eu-west-1.pooler.supabase.com:5432/postgres?sslmode=disable",
    "postgres://u:p@abc123.hyperdrive.local.evil.example:5432/db?sslmode=disable",
    "postgres://u:p@hyperdrive.local:5432/db?sslmode=disable",
    "postgres://u:p@127.0.0.1.evil.example:5432/db?sslmode=disable",
    "postgres://u:p@10.0.0.5:5432/db?sslmode=disable",
  ]) {
    assert.throws(() => assertPgConnectionString(url), /sslmode=disable/, url);
  }
});

test("Hyperdrive's own string (<id>.hyperdrive.local, sslmode=disable) is accepted: Hyperdrive does TLS to the origin", () => {
  // The form a Worker gets in env.HYPERDRIVE.connectionString (and wrangler's local emulation).
  const url = "postgres://postgres:pw@547414fe3a8b737a87dd17ca93df4b52.hyperdrive.local:5432/mail?sslmode=disable";
  assert.equal(assertPgConnectionString(url), url);
});

test("on loopback sslmode=disable is allowed: nothing off the machine sees it", () => {
  for (const url of [
    "postgres://u:p@127.0.0.1:61234/db?sslmode=disable",
    "postgresql://u:p@localhost:5432/db?sslmode=disable",
    "postgres://u:p@[::1]:5432/db?sslmode=disable",
  ]) {
    assert.equal(assertPgConnectionString(url), url);
  }
});

test("disabling certificate checks is refused everywhere, loopback included", () => {
  assert.throws(() => assertPgConnectionString("postgres://u:p@127.0.0.1/db?rejectUnauthorized=false"), /certificate/);
});
