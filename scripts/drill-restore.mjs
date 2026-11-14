#!/usr/bin/env node
/**
 * `npm run drill:restore`: a backup-and-restore drill (docs/ops/runbook.md, "Backup and restore").
 *
 * Proves that a database dump plus a copy of the blob store plus the key(s) is enough to get mail back:
 *   1. seed a drill mailbox in the SOURCE database and blob store, through the app's own code: sealed
 *      fields, a raw message blob and an attachment;
 *   2. pg_dump the source and restore it into an EMPTY target database (with psql);
 *   3. copy every referenced blob, as stored ciphertext, never decrypted, to an EMPTY target store;
 *   4. open the mail from the target only: the snapshot decrypts, the raw message and the attachment
 *      read back byte for byte;
 *   5. the same again with a MAIL_BLOB_KEYS ring (key rotation, docs/ops/key-rotation.md): mail
 *      sealed under two keys reads after restore with the ring, and not without the old key.
 *
 *   SOURCE_DATABASE_URL=postgres://…  TARGET_DATABASE_URL=postgres://…(empty)  npm run drill:restore -- \
 *     --storage fs | --storage s3 --s3-endpoint http://127.0.0.1:59000
 *
 * PG_DUMP / PSQL override the commands (e.g. "docker exec -i pg pg_dump"). It touches only the drill
 * mailbox in the source; the target must be an empty, throwaway database. Prints each step's time,
 * the RTO for this data set.
 */
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const SOURCE = process.env.SOURCE_DATABASE_URL;
const TARGET = process.env.TARGET_DATABASE_URL;
const STORAGE = arg("storage", "fs");
const S3_ENDPOINT = arg("s3-endpoint", "http://127.0.0.1:59000");
const PG_DUMP = process.env.PG_DUMP ?? "pg_dump";
const PSQL = process.env.PSQL ?? "psql";
if (!SOURCE || !TARGET || SOURCE === TARGET) {
  console.error("Set SOURCE_DATABASE_URL and an EMPTY, different TARGET_DATABASE_URL.");
  process.exit(1);
}

const KEY_OLD = randomBytes(32).toString("hex");
const KEY_NEW = randomBytes(32).toString("hex");
process.env.MAIL_BLOB_KEY = KEY_OLD;
delete process.env.MAIL_BLOB_KEYS;

const { createFilesystemDriver, createS3Driver } = await import("../src/lib/storage/driver.ts");
const { createSealedDriver } = await import("../src/lib/storage/index.ts");
const { sha256Hex } = await import("../src/lib/storage/adapter.ts");
const { keyringFromEnv } = await import("../src/lib/storage/keyring.ts");
const { openMailbox, readAttachment } = await import("../src/lib/mail/mailbox.ts");
const { insertAttachment, insertMessage, readSnapshot } = await import("../src/lib/mail/records.ts");

const timings = [];
const step = async (name, run) => {
  const t0 = performance.now();
  const out = await run();
  timings.push([name, performance.now() - t0]);
  console.log(`[drill] ok  ${name} (${(performance.now() - t0).toFixed(0)} ms)`);
  return out;
};
const fail = (message) => {
  console.error(`[drill] FAIL ${message}`);
  process.exit(1);
};

function rawDriver(which) {
  if (STORAGE === "s3") {
    return createS3Driver({ bucket: `drill-${which}-${Date.now().toString(36)}`, endpoint: S3_ENDPOINT, region: "us-east-1", accessKeyId: "drill", secretAccessKey: "drill", loopbackOnly: true });
  }
  return createFilesystemDriver(mkdtempSync(join(tmpdir(), `drill-${which}-`)));
}

/** TenantBlobs over a raw driver, sealed with the given keys (as openTenantStorage does). */
function blobs(driver, keys, tenantId) {
  const sealed = createSealedDriver(driver, keys);
  return {
    async put(bytes) {
      const blobId = randomBytes(16).toString("hex");
      await sealed.put(tenantId, blobId, bytes);
      return { blobId, sha256: await sha256Hex(bytes) };
    },
    async get(blobId) {
      try {
        const body = await sealed.get(tenantId, blobId);
        return { body, sha256: await sha256Hex(body) };
      } catch {
        return null;
      }
    },
    async delete(blobId) {
      await sealed.delete(tenantId, blobId);
    },
  };
}

const sourcePool = new pg.Pool({ connectionString: SOURCE, max: 2 });
const targetPool = new pg.Pool({ connectionString: TARGET, max: 2 });
const source = { query: async (t, p) => (await sourcePool.query(t, p)).rows };
const target = { query: async (t, p) => (await targetPool.query(t, p)).rows };

const empty = await target.query(`select count(*)::int as n from information_schema.tables where table_schema = 'cumulus_mail'`);
if (empty[0].n !== 0) fail("the target database is not empty: use a fresh, throwaway database");

const tenant = `drill-${Date.now().toString(36)}`;
const srcStore = rawDriver("src");
await srcStore.probe?.();
const text = (n) => `Drill message ${n}: ${randomBytes(6).toString("hex")}`;
const rawMail = new TextEncoder().encode(`From: a@example.org\r\nTo: ${tenant}@cumuluscloud.app\r\nSubject: Drill\r\n\r\nraw body`);
const attachmentBytes = randomBytes(4096);

/** Seed one message (sealed fields, raw blob, attachment) under `keys`. */
async function seed(keys, id, subject) {
  const store = blobs(srcStore, keys, tenant);
  const raw = await store.put(rawMail);
  const file = await store.put(attachmentBytes);
  await insertMessage(source, tenant, {
    id, threadId: id, folder: "inbox", from: { name: "Drill", email: "drill@example.org" },
    to: [{ name: tenant, email: `${tenant}@cumuluscloud.app` }], cc: [], subject, body: subject,
    at: new Date().toISOString(), unread: true, starred: false, labels: [],
  }, raw.blobId);
  await insertAttachment(source, tenant, id, { id: `a-${id}`, name: "drill.bin", size: attachmentBytes.length, contentType: "application/octet-stream", sha256: file.sha256, objectKey: file.blobId });
}

const subjects = { one: text(1), two: text(2) };
await step("seed the source (sealed under MAIL_BLOB_KEY)", async () => {
  await openMailbox(source, tenant, { name: tenant, email: `${tenant}@cumuluscloud.app`, cid: `cid:${tenant}`, plan: "Free", quotaGb: 15 });
  await seed(keyringFromEnv({ MAIL_BLOB_KEY: KEY_OLD }), "drill-1", subjects.one);
});
// After a rotation: key 1 current, key 0 still listed. The second message is sealed under key 1.
const ring = keyringFromEnv({ MAIL_BLOB_KEYS: `1:${KEY_NEW},0:${KEY_OLD}` });
await step("seed a second message under a MAIL_BLOB_KEYS ring (key 1)", async () => {
  process.env.MAIL_BLOB_KEYS = `1:${KEY_NEW},0:${KEY_OLD}`; // sealed fields follow the environment's ring
  await seed(ring, "drill-2", subjects.two);
  delete process.env.MAIL_BLOB_KEYS;
});

const dumpFile = join(mkdtempSync(join(tmpdir(), "drill-dump-")), "mail.sql");
await step("pg_dump the source", () => {
  execSync(`${PG_DUMP} --no-owner --no-privileges "${SOURCE}" > "${dumpFile}"`, { stdio: ["ignore", "ignore", "inherit"], shell: "/bin/bash" });
});
await step("restore into the empty target", () => {
  execSync(`${PSQL} -v ON_ERROR_STOP=1 -q "${TARGET}" < "${dumpFile}"`, { stdio: ["ignore", "ignore", "inherit"], shell: "/bin/bash" });
});

const dstStore = rawDriver("dst");
await dstStore.probe?.();
const copied = await step("copy the referenced blobs, as stored ciphertext", async () => {
  const ids = await source.query(
    `select raw_key as id from cumulus_mail.messages where tenant_id = $1 and raw_key is not null
     union select object_key from cumulus_mail.attachments where tenant_id = $1`,
    [tenant],
  );
  for (const { id } of ids) await dstStore.put(tenant, id, await srcStore.get(tenant, id));
  return ids.length;
});

await step("open the restored mail with the ring (both keys)", async () => {
  process.env.MAIL_BLOB_KEYS = `1:${KEY_NEW},0:${KEY_OLD}`;
  const snapshot = await readSnapshot(target, tenant);
  const got = Object.fromEntries(snapshot.messages.map((m) => [m.id, m.subject]));
  if (got["drill-1"] !== subjects.one || got["drill-2"] !== subjects.two) fail(`restored subjects differ: ${JSON.stringify(got)}`);
  for (const id of ["drill-1", "drill-2"]) {
    const file = await readAttachment(target, blobs(dstStore, ring, tenant), tenant, id, `a-${id}`);
    if (!file || Buffer.compare(Buffer.from(file.bytes), attachmentBytes) !== 0) fail(`attachment of ${id} did not restore byte for byte`);
    const rawKey = (await target.query(`select raw_key from cumulus_mail.messages where tenant_id = $1 and id = $2`, [tenant, id]))[0].raw_key;
    const raw = await blobs(dstStore, ring, tenant).get(rawKey);
    if (!raw || Buffer.compare(Buffer.from(raw.body), Buffer.from(rawMail)) !== 0) fail(`raw message of ${id} did not restore byte for byte`);
  }
});

await step("without the old key, the old message does not open (the backup needs every key)", async () => {
  process.env.MAIL_BLOB_KEYS = `1:${KEY_NEW}`;
  let opened = true;
  try {
    await readSnapshot(target, tenant);
  } catch {
    opened = false;
  }
  if (opened) fail("mail sealed under key 0 opened without key 0");
  delete process.env.MAIL_BLOB_KEYS;
});

await step("clean up the drill mailbox in the source", () => source.query(`delete from cumulus_mail.mailboxes where tenant_id = $1`, [tenant]));
await sourcePool.end();
await targetPool.end();
const total = timings.filter(([n]) => /pg_dump|restore|copy|open the restored/.test(n)).reduce((s, [, ms]) => s + ms, 0);
console.log(`[drill] PASS: ${copied} blobs, storage ${STORAGE}. Dump + restore + copy + first read took ${(total / 1000).toFixed(1)} s for this data set.`);
