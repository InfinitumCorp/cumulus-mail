import assert from "node:assert/strict";
import { test } from "node:test";
import { missingIngestSettings } from "./ingest-settings.ts";

const supabase = {
  MAIL_BLOB_KEY: "ab".repeat(32),
  MAIL_STORAGE: "s3",
  MAIL_S3_BUCKET: "cumulus-mail",
  MAIL_S3_ENDPOINT: "https://ivqiskeziohbbtkcvlun.supabase.co/storage/v1/s3",
  MAIL_S3_REGION: "eu-west-1",
  MAIL_S3_ACCESS_KEY_ID: "key-id",
  MAIL_S3_SECRET_ACCESS_KEY: "secret",
  CUMULUS_ALLOW_SUPABASE: "1",
};

test("a fully configured Worker environment is ready to accept inbound mail", () => {
  assert.deepEqual(missingIngestSettings(supabase, { hasDatabase: true, workers: true }), []);
});

test("an empty environment names the database, the blob key and the store", () => {
  assert.deepEqual(missingIngestSettings({}, { hasDatabase: false, workers: true }), [
    "DATABASE_URL (or a Hyperdrive binding named MAIL_DB)",
    "MAIL_BLOB_KEY",
    "MAIL_STORAGE=s3 (Workers have no local disk)",
  ]);
  // Under Node the default local-disk store is fine, so only the two names.
  assert.deepEqual(missingIngestSettings({}, { hasDatabase: false }), ["DATABASE_URL", "MAIL_BLOB_KEY"]);
});

test("the Hyperdrive binding counts as the database", () => {
  assert.deepEqual(missingIngestSettings(supabase, { hasDatabase: true, workers: true }), []);
  assert.deepEqual(missingIngestSettings(supabase, { hasDatabase: false, workers: true }), [
    "DATABASE_URL (or a Hyperdrive binding named MAIL_DB)",
  ]);
});

test("whitespace is not a value", () => {
  assert.deepEqual(
    missingIngestSettings({ ...supabase, MAIL_BLOB_KEY: "   ", MAIL_S3_BUCKET: "" }, { hasDatabase: true, workers: true }),
    ["MAIL_BLOB_KEY", "MAIL_S3_BUCKET"],
  );
});

test("the S3 store names each credential it is missing", () => {
  const { MAIL_S3_ACCESS_KEY_ID, MAIL_S3_SECRET_ACCESS_KEY, ...partial } = supabase;
  void MAIL_S3_ACCESS_KEY_ID;
  void MAIL_S3_SECRET_ACCESS_KEY;
  assert.deepEqual(missingIngestSettings(partial, { hasDatabase: true, workers: true }), [
    "MAIL_S3_ACCESS_KEY_ID",
    "MAIL_S3_SECRET_ACCESS_KEY",
  ]);
});

test("a Supabase endpoint needs the gate flag that the driver also checks", () => {
  const { CUMULUS_ALLOW_SUPABASE, ...ungated } = supabase;
  void CUMULUS_ALLOW_SUPABASE;
  assert.deepEqual(missingIngestSettings(ungated, { hasDatabase: true, workers: true }), [
    "CUMULUS_ALLOW_SUPABASE=1",
  ]);
  assert.deepEqual(
    missingIngestSettings({ ...ungated, CUMULUS_ALLOW_SUPABASE: "yes" }, { hasDatabase: true, workers: true }),
    ["CUMULUS_ALLOW_SUPABASE=1"],
  );
  // A non-Supabase endpoint does not need the flag.
  assert.deepEqual(
    missingIngestSettings(
      { ...ungated, MAIL_S3_ENDPOINT: "http://127.0.0.1:8333" },
      { hasDatabase: true, workers: true },
    ),
    [],
  );
});

test("local disk is accepted under Node and refused on Workers", () => {
  const local = { MAIL_BLOB_KEY: supabase.MAIL_BLOB_KEY };
  assert.deepEqual(missingIngestSettings(local, { hasDatabase: true }), []);
  assert.deepEqual(missingIngestSettings(local, { hasDatabase: true, workers: true }), [
    "MAIL_STORAGE=s3 (Workers have no local disk)",
  ]);
  // "S3" the setting is case-insensitive, like the driver's own read.
  assert.deepEqual(
    missingIngestSettings({ ...supabase, MAIL_STORAGE: " S3 " }, { hasDatabase: true, workers: true }),
    [],
  );
});
