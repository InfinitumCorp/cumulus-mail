import assert from "node:assert/strict";
import { test } from "node:test";
import { blobFile, blobObjectKey } from "../../../src/lib/storage/driver.ts";
import { readFile } from "node:fs/promises";
import { createHarness, profile } from "../../../src/lib/mail/test-support.ts";
import { openMailbox } from "../../../src/lib/mail/mailbox.ts";
import { handleEmail } from "./index.ts";
import { openWorkerIngest } from "./bindings.ts";

const KEY = "ab".repeat(32);
const PLAIN = "Stored by the binding wiring.";

function workerEnv(
  harness: Awaited<ReturnType<typeof createHarness>>,
  flag: { closed: boolean },
  bucket = "",
) {
  return {
    HYPERDRIVE: {
      connectionString: "postgres://db.example:5432/postgres?sslmode=require",
    },
    SUPABASE_S3_ENDPOINT: "https://ivqiskeziohbbtkcvlun.supabase.co/storage/v1/s3",
    SUPABASE_S3_REGION: "us-east-1",
    SUPABASE_S3_ACCESS_KEY_ID: "key",
    SUPABASE_S3_SECRET_ACCESS_KEY: "secret",
    ...(bucket ? { SUPABASE_S3_BUCKET: bucket } : {}),
    MAIL_BLOB_KEY: KEY,
    CUMULUS_ALLOW_SUPABASE: "1",
    MAIL_DOMAIN: "cumuluscloud.app",
    ingestHooks: {
      async connect(connectionString: string) {
        assert.match(connectionString, /sslmode=require/);
        assert.equal(/sslmode=disable/i.test(connectionString), false);
        return {
          query: (text: string, params?: unknown[]) => harness.db.query(text, params),
          end: async () => {
            flag.closed = true;
          },
        };
      },
      createDriver(options: { bucket: string; endpoint?: string; forcePathStyle?: boolean }) {
        assert.equal(options.bucket, bucket || "cumulus-mail");
        assert.equal(options.endpoint, "https://ivqiskeziohbbtkcvlun.supabase.co/storage/v1/s3");
        assert.equal(options.forcePathStyle, undefined);
        return harness.driver;
      },
    },
  };
}

test("Hyperdrive wiring stores an encrypted blob and closes the client", async () => {
  const previousKey = process.env.MAIL_BLOB_KEY;
  const previousAllow = process.env.CUMULUS_ALLOW_SUPABASE;
  const harness = await createHarness();
  const closed = { closed: false };
  const env = workerEnv(harness, closed);
  try {
    await openMailbox(
      harness.db,
      "wire-ada",
      profile("wire-ada", "wire.ada@cumuluscloud.app", "Ada"),
    );
    const raw = new TextEncoder().encode(
      [
        "From: Leah <leah@cumuluscloud.app>",
        "To: Ada <wire.ada@cumuluscloud.app>",
        "Subject: Wiring",
        "Content-Type: text/plain",
        "",
        PLAIN,
      ].join("\r\n"),
    );
    const stored = await handleEmail(
      { from: "leah@cumuluscloud.app", to: "wire.ada@cumuluscloud.app", raw },
      env,
    );
    assert.equal(stored.stored.length, 1);
    const rows = await harness.db.query<{ subject: string; body: string; raw_key: string }>(
      `select subject, body, raw_key from cumulus_mail.messages where tenant_id = $1 and id = $2`,
      ["wire-ada", stored.stored[0]],
    );
    assert.equal(rows[0]?.subject.includes("Wiring"), false);
    assert.equal(rows[0]?.body.includes(PLAIN), false);
    const blobId = rows[0]?.raw_key ?? "";
    assert.equal(blobObjectKey("wire-ada", blobId), `tenants/wire-ada/${blobId}`);
    const onDisk = await readFile(blobFile(harness.root, "wire-ada", blobId));
    assert.equal(onDisk.includes(Buffer.from(PLAIN)), false);
    const opened = await harness.storageFor("wire-ada").get(blobId);
    assert.equal(opened?.body.byteLength, raw.byteLength);
    assert.equal(closed.closed, true);
  } finally {
    if (previousKey === undefined) delete process.env.MAIL_BLOB_KEY;
    else process.env.MAIL_BLOB_KEY = previousKey;
    if (previousAllow === undefined) delete process.env.CUMULUS_ALLOW_SUPABASE;
    else process.env.CUMULUS_ALLOW_SUPABASE = previousAllow;
    await harness.close();
  }
});

test("a missing Hyperdrive binding still refuses to store mail", async () => {
  await assert.rejects(
    () =>
      handleEmail(
        { from: "a@cumuluscloud.app", to: "b@cumuluscloud.app", raw: new Uint8Array() },
        {},
      ),
    /not deployed/,
  );
  await assert.rejects(() => openWorkerIngest({}), /not deployed/);
});

test("sslmode=disable is refused before a connection is opened", async () => {
  let connected = false;
  await assert.rejects(
    () =>
      openWorkerIngest({
        HYPERDRIVE: { connectionString: "postgres://db.example:5432/postgres?sslmode=disable" },
        SUPABASE_S3_ENDPOINT: "https://ivqiskeziohbbtkcvlun.supabase.co/storage/v1/s3",
        SUPABASE_S3_ACCESS_KEY_ID: "key",
        SUPABASE_S3_SECRET_ACCESS_KEY: "secret",
        MAIL_BLOB_KEY: KEY,
        CUMULUS_ALLOW_SUPABASE: "1",
        ingestHooks: {
          connect: async () => {
            connected = true;
            throw new Error("should not connect");
          },
        },
      }),
    /sslmode=disable/,
  );
  assert.equal(connected, false);
});
