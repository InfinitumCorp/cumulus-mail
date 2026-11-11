/**
 * Real-database inbound test. Disabled unless MAIL_INBOUND_LIVE=1.
 * It does not send mail, change DNS, or deploy a Worker.
 *
 * The connection string is the Hyperdrive origin: Supabase session pooler,
 * port 5432, sslmode=require. Inside the Worker the same database is reached
 * through env.HYPERDRIVE.connectionString. This script runs outside the
 * Worker, so it uses HYPERDRIVE_CONNECTION_STRING or DATABASE_URL.
 *
 * Requires node --experimental-strip-types when the flag is on, because it
 * imports the TypeScript handler. With the flag unset it exits 0 and imports
 * nothing from the Worker.
 */
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const SUBJECT = "Live inbound probe";
const BODY = "Stored by the live inbound probe.";

function trim(env, name) {
  const value = env[name];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function inboundLiveEnabled(env = process.env) {
  return trim(env, "MAIL_INBOUND_LIVE") === "1";
}

export function liveConnectionString(env = process.env) {
  return trim(env, "HYPERDRIVE_CONNECTION_STRING") || trim(env, "DATABASE_URL");
}

export function liveS3(env = process.env) {
  return {
    endpoint: trim(env, "SUPABASE_S3_ENDPOINT") || trim(env, "MAIL_S3_ENDPOINT"),
    region: trim(env, "SUPABASE_S3_REGION") || trim(env, "MAIL_S3_REGION") || "us-east-1",
    bucket: trim(env, "SUPABASE_S3_BUCKET") || trim(env, "MAIL_S3_BUCKET") || "cumulus-mail",
    accessKeyId: trim(env, "SUPABASE_S3_ACCESS_KEY_ID") || trim(env, "MAIL_S3_ACCESS_KEY_ID"),
    secretAccessKey:
      trim(env, "SUPABASE_S3_SECRET_ACCESS_KEY") || trim(env, "MAIL_S3_SECRET_ACCESS_KEY"),
    loopbackOnly: trim(env, "MAIL_S3_LOOPBACK_ONLY") === "1",
  };
}

/** Session pooler rules for a non-local database. Loopback skips the TLS and port rules. */
export function assertSessionPooler(connectionString) {
  const value = connectionString.trim();
  if (!value)
    throw new Error("Live inbound test needs HYPERDRIVE_CONNECTION_STRING or DATABASE_URL");
  if (/sslmode=disable/i.test(value)) {
    throw new Error("Refusing sslmode=disable. Use sslmode=require.");
  }
  let host = "";
  let port = "";
  try {
    const parsed = new URL(value.replace(/^postgres(ql)?:/i, "http:"));
    host = parsed.hostname;
    port = parsed.port;
  } catch {
    throw new Error("Database connection string is not a URL");
  }
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!loopback) {
    if (port !== "5432") {
      throw new Error("Live database URL must use port 5432 (session mode). Do not use 6543.");
    }
    if (!/[?&]sslmode=require(?:&|$)/i.test(value)) {
      throw new Error("Live database URL must include sslmode=require.");
    }
  }
  return value;
}

function workerEnv(env, connectionString) {
  const s3 = liveS3(env);
  return {
    HYPERDRIVE: { connectionString },
    SUPABASE_S3_ENDPOINT: s3.endpoint,
    SUPABASE_S3_REGION: s3.region,
    SUPABASE_S3_BUCKET: s3.bucket,
    SUPABASE_S3_ACCESS_KEY_ID: s3.accessKeyId,
    SUPABASE_S3_SECRET_ACCESS_KEY: s3.secretAccessKey,
    MAIL_S3_LOOPBACK_ONLY: s3.loopbackOnly ? "1" : "",
    MAIL_BLOB_KEY: trim(env, "MAIL_BLOB_KEY"),
    CUMULUS_ALLOW_SUPABASE: trim(env, "CUMULUS_ALLOW_SUPABASE"),
    MAIL_DOMAIN: trim(env, "MAIL_DOMAIN") || "cumuluscloud.app",
  };
}

async function cleanup(openWorkerIngest, env, tenantId) {
  const opened = await openWorkerIngest(env);
  try {
    const blobs = await opened.db.query(
      `select raw_key as blob_id from cumulus_mail.messages where tenant_id = $1 and raw_key is not null
       union
       select object_key as blob_id from cumulus_mail.attachments where tenant_id = $1`,
      [tenantId],
    );
    const storage = opened.storageFor(tenantId);
    for (const row of blobs) {
      if (row.blob_id) await storage.delete(row.blob_id);
    }
    await opened.db.query(`delete from cumulus_mail.address_routes where tenant_id = $1`, [
      tenantId,
    ]);
    await opened.db.query(`delete from cumulus_mail.messages where tenant_id = $1`, [tenantId]);
    await opened.db.query(`delete from cumulus_mail.deliveries where sender_tenant = $1`, [
      tenantId,
    ]);
    await opened.db.query(`delete from cumulus_mail.mailboxes where tenant_id = $1`, [tenantId]);
  } finally {
    await opened.close();
  }
}

export async function runInboundLive(env = process.env) {
  if (!inboundLiveEnabled(env)) return { status: "skipped" };
  const connectionString = assertSessionPooler(liveConnectionString(env));
  const s3 = liveS3(env);
  if (!s3.endpoint || !s3.accessKeyId || !s3.secretAccessKey) {
    throw new Error(
      "Live inbound test needs SUPABASE_S3_ENDPOINT, SUPABASE_S3_ACCESS_KEY_ID, and SUPABASE_S3_SECRET_ACCESS_KEY",
    );
  }
  if (!trim(env, "MAIL_BLOB_KEY")) throw new Error("MAIL_BLOB_KEY is not set");
  if (/supabase\.co/i.test(s3.endpoint) && trim(env, "CUMULUS_ALLOW_SUPABASE") !== "1") {
    throw new Error("CUMULUS_ALLOW_SUPABASE=1 is required for the Supabase Storage endpoint");
  }

  const { openWorkerIngest } = await import("../workers/email/src/bindings.ts");
  const { handleEmail } = await import("../workers/email/src/index.ts");
  const { openMailbox } = await import("../src/lib/mail/mailbox.ts");
  const { createS3Driver } = await import("../src/lib/storage/driver.ts");

  const suffix = randomBytes(4).toString("hex");
  const tenantId = `live${suffix}`;
  const address = `live-${suffix}@cumuluscloud.app`;
  const bindings = workerEnv(env, connectionString);
  const raw = [
    "From: Smoke <smoke-sender@example.test>",
    `To: <${address}>`,
    `Subject: ${SUBJECT}`,
    "Message-ID: <live-inbound-probe@example.test>",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    BODY,
    "",
  ].join("\r\n");

  try {
    const setup = await openWorkerIngest(bindings);
    try {
      await openMailbox(setup.db, tenantId, {
        name: "Live",
        email: address,
        cid: `cid:${tenantId}`,
        plan: "Free",
        quotaGb: 15,
      });
    } finally {
      await setup.close();
    }

    const stored = await handleEmail(
      { from: "smoke-sender@example.test", to: address, raw: new TextEncoder().encode(raw) },
      bindings,
    );
    if (stored.stored.length !== 1) throw new Error("Inbound handler did not store the message");

    const check = await openWorkerIngest(bindings);
    try {
      const rows = await check.db.query(
        `select subject, body, raw_key from cumulus_mail.messages where tenant_id = $1 and id = $2`,
        [tenantId, stored.stored[0]],
      );
      const row = rows[0];
      if (!row?.raw_key) throw new Error("Stored message has no blob id");
      if (String(row.subject).includes(SUBJECT)) throw new Error("subject was stored in plaintext");
      if (String(row.body).includes(BODY)) throw new Error("body was stored in plaintext");
      const driver = createS3Driver({
        endpoint: s3.endpoint,
        region: s3.region,
        bucket: s3.bucket,
        accessKeyId: s3.accessKeyId,
        secretAccessKey: s3.secretAccessKey,
        loopbackOnly: s3.loopbackOnly,
      });
      const sealed = Buffer.from(await driver.get(tenantId, row.raw_key));
      if (sealed.includes(Buffer.from(BODY))) throw new Error("blob was stored in plaintext");
      const opened = await check.storageFor(tenantId).get(row.raw_key);
      const text = new TextDecoder().decode(opened?.body ?? new Uint8Array());
      if (!text.includes(BODY)) throw new Error("sealed blob did not open to the probe body");
    } finally {
      await check.close();
    }
    console.log("[smoke] inbound live probe stored ciphertext");
    return { status: "passed", tenantId };
  } finally {
    await cleanup(openWorkerIngest, bindings, tenantId);
  }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  if (!inboundLiveEnabled()) {
    console.log(
      "[inbound-live] skipped (set MAIL_INBOUND_LIVE=1 to run against the real database)",
    );
    process.exit(0);
  }
  try {
    await runInboundLive();
  } catch (error) {
    console.error(`[inbound-live] ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
