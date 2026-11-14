import assert from "node:assert/strict";
import { test } from "node:test";
import { createS3Driver, newBlobId } from "./driver.ts";

const endpoint = process.env.MAIL_S3_ENDPOINT?.trim();
const ready = Boolean(endpoint);
// Never run against production (the shared "Infinitum Corp" Supabase project).
if (endpoint?.includes("ivqiskeziohbbtkcvlun")) {
  throw new Error("Refusing to run the S3 integration test against the production Supabase project");
}

test("the S3 driver stores and reads bytes on a local S3 endpoint", { skip: ready || process.env.CI ? false : "MinIO is not configured" }, async () => {
  if (!endpoint) throw new Error("MAIL_S3_ENDPOINT is required when CI runs the S3 service");
  const driver = createS3Driver({
    endpoint,
    region: process.env.MAIL_S3_REGION?.trim() || "us-east-1",
    bucket: process.env.MAIL_S3_BUCKET?.trim() || "cumulus-mail",
    accessKeyId: process.env.MAIL_S3_ACCESS_KEY_ID?.trim() || "cumulus",
    secretAccessKey: process.env.MAIL_S3_SECRET_ACCESS_KEY?.trim() || "cumulussecret",
    loopbackOnly: process.env.MAIL_S3_LOOPBACK_ONLY !== "0",
  });
  assert.equal(await driver.probe(), true);
  const blobId = newBlobId();
  const payload = Buffer.from("s3-round-trip");
  await driver.put("tenant-s3", blobId, payload);
  assert.equal(Buffer.from(await driver.get("tenant-s3", blobId)).toString(), "s3-round-trip");
  await driver.delete("tenant-s3", blobId);
  await assert.rejects(() => driver.get("tenant-s3", blobId), /Blob not found/);
});
