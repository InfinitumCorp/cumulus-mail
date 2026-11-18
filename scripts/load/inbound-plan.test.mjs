import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregate, loadTarget } from "./inbound-plan.mjs";

test("loopback runs with the stand-in; anything remote needs --target staging and real bucket settings", () => {
  const local = loadTarget({ databaseUrl: "postgres://p@127.0.0.1:5432/x", s3Endpoint: "http://127.0.0.1:59000", target: "", env: {} });
  assert.equal(local.s3.MAIL_S3_LOOPBACK_ONLY, "1");

  const remote = { databaseUrl: "postgres://p@db.staging.supabase.co:5432/postgres", s3Endpoint: "https://staging.supabase.co/storage/v1/s3" };
  assert.match(loadTarget({ ...remote, target: "", env: {} }).error, /pass --target staging/);
  assert.match(loadTarget({ ...remote, target: "staging", env: {} }).error, /S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET/);
  const env = { S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s", S3_BUCKET: "b" };
  const ok = loadTarget({ ...remote, target: "staging", env });
  assert.deepEqual(ok.s3, { SUPABASE_S3_REGION: "us-east-1", SUPABASE_S3_ACCESS_KEY_ID: "k", SUPABASE_S3_SECRET_ACCESS_KEY: "s", SUPABASE_S3_BUCKET: "b" });
  assert.match(loadTarget({ ...remote, target: "staging", env: { ...env, LOAD_PRODUCTION_DB_HOST: "DB.staging.supabase.co" } }).error, /production database/);
  // A remote database with a loopback bucket is still remote.
  assert.match(loadTarget({ ...remote, s3Endpoint: "http://127.0.0.1:59000", target: "", env: {} }).error, /db.staging.supabase.co/);
});

test("results from several processes add up", () => {
  const all = aggregate([
    { stored: [5, 7, 9], errors: 0, errorKinds: {}, peak: 4, elapsed: 10 },
    { stored: [6, 8, 100], errors: 2, errorKinds: { timeout: 2 }, peak: 6, elapsed: 12 },
  ]);
  assert.equal(all.stored, 6);
  assert.equal(all.errors, 2);
  assert.deepEqual(all.errorKinds, { timeout: 2 });
  assert.equal(all.peak, 10);
  assert.equal(all.rate, 0.5);
  assert.equal(all.p50, "8.0");
  assert.equal(all.max, "100.0");
});
