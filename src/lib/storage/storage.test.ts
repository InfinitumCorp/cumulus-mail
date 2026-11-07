import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { masterKeyFromEnv, openSeal, seal } from "./crypto.ts";
import {
  blobFile,
  createFilesystemDriver,
  createS3Driver,
  newBlobId,
} from "./driver.ts";
import { createSealedDriver } from "./index.ts";

if (!process.env.MAIL_BLOB_KEY) process.env.MAIL_BLOB_KEY = "cd".repeat(32);

const root = await mkdtemp(join(tmpdir(), "cumulus-storage-"));
after(async () => {
  await rm(root, { recursive: true, force: true });
});

const plaintext = new TextEncoder().encode("forecast appendix");

test("filesystem driver matches Drive put/get/delete/probe and hides ciphertext", async () => {
  const inner = createFilesystemDriver(root);
  assert.equal(await inner.probe(), true);
  const sealed = createSealedDriver(inner, masterKeyFromEnv());
  const blobId = newBlobId();
  await sealed.put("tenant-a", blobId, plaintext);
  const onDisk = await readFile(blobFile(root, "tenant-a", blobId));
  assert.equal(onDisk.includes(Buffer.from(plaintext)), false);
  const opened = await sealed.get("tenant-a", blobId);
  assert.equal(Buffer.from(opened).toString(), "forecast appendix");
  await sealed.delete("tenant-a", blobId);
});

test("AES-256-GCM detects tampering and rejects another tenant key", async () => {
  const master = masterKeyFromEnv();
  const sealed = seal(master, "tenant-a", plaintext);
  assert.equal(Buffer.from(openSeal(master, "tenant-a", sealed)).toString(), "forecast appendix");
  const tampered = new Uint8Array(sealed);
  tampered[20] ^= 0xff;
  assert.throws(() => openSeal(master, "tenant-a", tampered));
  assert.throws(() => openSeal(master, "tenant-b", sealed));
});

test("the S3 driver matches Drive's options and refuses a live endpoint", () => {
  assert.throws(() => createS3Driver({ bucket: "mail", endpoint: "https://abc.supabase.co", loopbackOnly: false }), /Supabase/);
  assert.throws(
    () => createS3Driver({ bucket: "mail", endpoint: "https://s3.amazonaws.com", loopbackOnly: true }),
    /loopback/,
  );
  const driver = createS3Driver({
    bucket: "cumulus-mail-preview",
    endpoint: "http://127.0.0.1:9000",
    region: "us-east-1",
    accessKeyId: "test",
    secretAccessKey: "test",
    loopbackOnly: true,
  });
  assert.equal(driver.kind, "s3");
  assert.equal(driver.bucket, "cumulus-mail-preview");
  assert.equal(typeof driver.ensureBucket, "function");
  assert.equal(typeof driver.put, "function");
});
