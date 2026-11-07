import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  ChecksumMismatchError,
  TenantAccessError,
  bindTenantStorage,
  checksumOf,
} from "./adapter.ts";
import { createStorageDriver, LocalDiskStorageDriver, S3CompatibleStorageDriver } from "./index.ts";

const root = await mkdtemp(join(tmpdir(), "cumulus-storage-"));
after(async () => {
  await rm(root, { recursive: true, force: true });
});

const bytes = new TextEncoder().encode("forecast appendix");

test("local disk writes are checksummed, atomic, and tenant scoped", async () => {
  const driver = new LocalDiskStorageDriver(root);
  const alice = bindTenantStorage(driver, "tenant-a");
  const bob = bindTenantStorage(driver, "tenant-b");
  const checksum = await checksumOf(bytes);
  await alice.put("notes/forecast.txt", bytes, { contentType: "text/plain", checksumSha256: checksum });
  const stored = await alice.get("notes/forecast.txt");
  assert.equal(stored?.key, "tenant/tenant-a/notes/forecast.txt");
  assert.equal(stored?.checksumSha256, checksum);
  assert.equal(new TextDecoder().decode(stored?.body), "forecast appendix");
  const meta = await alice.head("notes/forecast.txt");
  assert.equal(meta?.size, bytes.byteLength);
  const listed = await alice.list("notes");
  assert.deepEqual(listed.map((item) => item.objectKey), ["notes/forecast.txt"]);
  assert.equal((await bob.get("notes/forecast.txt")), null);
  assert.equal((await bob.list()).length, 0);

  await assert.rejects(
    () => alice.put("notes/bad.txt", bytes, { contentType: "text/plain", checksumSha256: "00".repeat(32) }),
    ChecksumMismatchError,
  );
  assert.equal((await alice.list()).length, 1);

  await assert.rejects(() => alice.get("../../tenant/tenant-b/secret"), TenantAccessError);
  await assert.rejects(() => alice.get("tenant/tenant-b/secret"), TenantAccessError);

  const url = await alice.signedShareUrl("notes/forecast.txt", 60);
  assert.match(url, /^stub:\/\/cumulus-share\/tenant\/tenant-a\/notes\/forecast.txt\?exp=\d+&signed=0$/);

  const file = join(root, "tenant", "tenant-a", "notes", "forecast.txt");
  await writeFile(file, "tampered");
  await assert.rejects(() => alice.get("notes/forecast.txt"), ChecksumMismatchError);
});

test("the default driver is local disk and the S3 driver is a stub", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cumulus-default-"));
  try {
    const local = createStorageDriver({ MAIL_BLOB_DIR: dir });
    assert.equal(local instanceof LocalDiskStorageDriver, true);
    const s3 = createStorageDriver({ MAIL_STORAGE: "s3", MAIL_S3_BUCKET: "cumulus-mail-preview" });
    assert.equal(s3 instanceof S3CompatibleStorageDriver, true);
    let fetched = false;
    const original = globalThis.fetch;
    globalThis.fetch = ((..._args: unknown[]) => {
      fetched = true;
      return Promise.reject(new Error("network disabled"));
    }) as typeof fetch;
    try {
      const checksum = await checksumOf(bytes);
      await assert.rejects(
        () => s3.put("tenant/tenant-a/x", bytes, { contentType: "text/plain", checksumSha256: checksum }),
        /stub/,
      );
      const adapter = bindTenantStorage(s3, "tenant-a");
      const url = await adapter.signedShareUrl("notes/x");
      assert.match(url, /^stub:\/\/cumulus-share\/tenant\/tenant-a\/notes\/x\?/);
      assert.equal(fetched, false);
    } finally {
      globalThis.fetch = original;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
