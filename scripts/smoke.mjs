#!/usr/bin/env node
/**
 * Operator smoke check. Reads environment variables only.
 * Unset sections are skipped and the process still exits 0.
 * It does not apply migrations, create buckets, send mail, or change DNS.
 *
 * Storage runs only when MAIL_S3_ENDPOINT, MAIL_S3_BUCKET,
 * MAIL_S3_ACCESS_KEY_ID, and MAIL_S3_SECRET_ACCESS_KEY are set.
 * A Supabase host also requires CUMULUS_ALLOW_SUPABASE=1.
 * Database runs only when DATABASE_URL is set.
 * OIDC discovery runs only when CUMULUS_OIDC_ISSUER is set.
 * The app default issuer is the live Cumulus://ID realm in
 * src/lib/auth/issuer-defaults.mjs. Set CUMULUS_OIDC_ISSUER to that value
 * to check discovery. Unset skips the network call. Cognito is only used
 * when CUMULUS_OIDC_ISSUER is set to that issuer.
 * The real-database inbound probe runs only when MAIL_INBOUND_LIVE=1.
 * See scripts/inbound-live.mjs. It is off for CI.
 *
 * Storage imports the TypeScript driver, so a configured storage check needs:
 *   node --experimental-strip-types scripts/smoke.mjs
 * The skip path runs under plain `node`.
 */
import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { pendingMigrations } from "./migration-plan.mjs";
import { inboundLiveEnabled, runInboundLive } from "./inbound-live.mjs";

const MAIL_MIGRATIONS = [
  "0002_cumulus_mail.sql",
  "0003_mail_auth_share.sql",
  "0004_message_metadata.sql",
  "0005_profile_and_routes.sql",
  "0006_mail_rls.sql",
];

function trim(env, name) {
  const value = env[name];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function smokePlan(env = process.env) {
  return {
    storage: Boolean(
      trim(env, "MAIL_S3_ENDPOINT") &&
      trim(env, "MAIL_S3_BUCKET") &&
      trim(env, "MAIL_S3_ACCESS_KEY_ID") &&
      trim(env, "MAIL_S3_SECRET_ACCESS_KEY"),
    ),
    database: Boolean(trim(env, "DATABASE_URL")),
    oidc: Boolean(trim(env, "CUMULUS_OIDC_ISSUER")),
    inbound: inboundLiveEnabled(env),
  };
}

async function checkStorage(env) {
  let createS3Driver;
  try {
    ({ createS3Driver } = await import("../src/lib/storage/driver.ts"));
  } catch (error) {
    throw new Error(
      `Storage is configured but the S3 driver did not load (${error instanceof Error ? error.message : error}). Re-run with: node --experimental-strip-types scripts/smoke.mjs`,
    );
  }
  const driver = createS3Driver({
    endpoint: trim(env, "MAIL_S3_ENDPOINT"),
    region: trim(env, "MAIL_S3_REGION") || "us-east-1",
    bucket: trim(env, "MAIL_S3_BUCKET"),
    accessKeyId: trim(env, "MAIL_S3_ACCESS_KEY_ID"),
    secretAccessKey: trim(env, "MAIL_S3_SECRET_ACCESS_KEY"),
    loopbackOnly: trim(env, "MAIL_S3_LOOPBACK_ONLY") === "1",
  });
  const blobId = randomBytes(16).toString("hex");
  const payload = Buffer.from("cumulus-mail-smoke");
  await driver.put("smoke-tenant-a", blobId, payload);
  try {
    const got = Buffer.from(await driver.get("smoke-tenant-a", blobId));
    if (got.toString() !== "cumulus-mail-smoke") throw new Error("Stored bytes did not round-trip");
    let denied = false;
    try {
      await driver.get("smoke-tenant-b", blobId);
    } catch (error) {
      denied = error instanceof Error && /not found/i.test(error.message);
    }
    if (!denied) throw new Error("Cross-tenant read was not denied");
  } finally {
    await driver.delete("smoke-tenant-a", blobId);
  }
  let gone = false;
  try {
    await driver.get("smoke-tenant-a", blobId);
  } catch (error) {
    gone = error instanceof Error && /not found/i.test(error.message);
  }
  if (!gone) throw new Error("Deleted object was still readable");
  console.log("[smoke] storage put, get, cross-tenant denial, and delete passed");
}

async function checkDatabase(env) {
  const pool = new pg.Pool({ connectionString: trim(env, "DATABASE_URL"), max: 1 });
  const client = await pool.connect();
  try {
    await client.query("select 1 as ok");
    const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
    const entries = await readdir(migrationsDir);
    let applied = [];
    try {
      const result = await client.query("select name from _migrations");
      applied = result.rows.map((row) => row.name);
    } catch (error) {
      const code = error && typeof error === "object" ? error.code : "";
      if (code !== "42P01") throw error;
      applied = [];
    }
    const pending = pendingMigrations(entries, applied)
      .map((item) => item.name)
      .filter((name) => MAIL_MIGRATIONS.includes(name));
    if (pending.length > 0) {
      throw new Error(`Migrations awaiting approval and not applied: ${pending.join(", ")}`);
    }
    const schema = await client.query(
      "select 1 from information_schema.schemata where schema_name = 'cumulus_mail'",
    );
    if (schema.rowCount !== 1) throw new Error("Schema cumulus_mail is missing");
    console.log("[smoke] database connection and migrations passed");
  } finally {
    client.release();
    await pool.end();
  }
}

async function checkOidc(env) {
  const issuer = trim(env, "CUMULUS_OIDC_ISSUER").replace(/\/+$/, "");
  const response = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!response.ok) throw new Error(`OIDC discovery returned HTTP ${response.status}`);
  const document = await response.json();
  if (typeof document.issuer !== "string" || typeof document.jwks_uri !== "string") {
    throw new Error("OIDC discovery document is missing issuer or jwks_uri");
  }
  console.log("[smoke] oidc discovery passed");
}

export async function runSmoke(env = process.env) {
  const plan = smokePlan(env);
  const failures = [];
  if (!plan.storage) console.log("[smoke] storage skipped (S3 environment is unset)");
  else {
    try {
      await checkStorage(env);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (!plan.database) console.log("[smoke] database skipped (DATABASE_URL unset)");
  else {
    try {
      await checkDatabase(env);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (!plan.oidc) console.log("[smoke] oidc skipped (CUMULUS_OIDC_ISSUER unset)");
  else {
    try {
      await checkOidc(env);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (!plan.inbound) console.log("[smoke] inbound skipped (MAIL_INBOUND_LIVE is not 1)");
  else {
    try {
      await runInboundLive(env);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(`[smoke] ${failure}`);
    return 1;
  }
  return 0;
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  const code = await runSmoke();
  process.exit(code);
}
