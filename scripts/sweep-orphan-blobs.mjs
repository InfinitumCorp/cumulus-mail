#!/usr/bin/env node
/**
 * Find stored blobs no row points at (src/lib/mail/blob-sweeper.ts).
 *
 *   DATABASE_URL=... MAIL_STORAGE=s3 MAIL_S3_*=... npm run blobs:sweep            report only (default)
 *   DATABASE_URL=... ... npm run blobs:sweep -- --apply                            delete them
 *   ... -- --min-age-hours 72                                                      only older than 72 h
 *
 * Reports per mailbox and in total; prints no blob contents. Exit 0 always on a report, 1 on an error.
 */
import pg from "pg";
import { createFilesystemDriver, createS3Driver } from "../src/lib/storage/driver.ts";
import { sweepOrphanBlobs, DEFAULT_MIN_AGE_MS } from "../src/lib/mail/blob-sweeper.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const hoursAt = args.indexOf("--min-age-hours");
const minAgeMs = hoursAt >= 0 ? Number(args[hoursAt + 1]) * 3_600_000 : DEFAULT_MIN_AGE_MS;
if (!Number.isFinite(minAgeMs) || minAgeMs < 3_600_000) {
  console.error("[sweep] --min-age-hours must be at least 1");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("[sweep] DATABASE_URL is not set");
  process.exit(1);
}

const env = process.env;
const driver =
  (env.MAIL_STORAGE ?? "local").trim().toLowerCase() === "s3"
    ? createS3Driver({
        bucket: env.MAIL_S3_BUCKET ?? "",
        endpoint: env.MAIL_S3_ENDPOINT || undefined,
        region: env.MAIL_S3_REGION || "us-east-1",
        accessKeyId: env.MAIL_S3_ACCESS_KEY_ID,
        secretAccessKey: env.MAIL_S3_SECRET_ACCESS_KEY,
      })
    : createFilesystemDriver(env.MAIL_BLOB_DIR || ".data/mail-blobs");

const client = new pg.Client({ connectionString: env.DATABASE_URL });
await client.connect();
try {
  const db = { query: async (text, params = []) => (await client.query(text, params)).rows };
  const report = await sweepOrphanBlobs(db, driver, { apply, minAgeMs });
  const mb = (b) => `${(b / 1048576).toFixed(2)} MB`;
  console.log(`[sweep] ${apply ? "APPLIED" : "dry run (nothing deleted; add --apply to delete)"}`);
  console.log(`[sweep] scanned ${report.scanned}, referenced ${report.referenced}, too new ${report.tooNew}`);
  console.log(`[sweep] orphans ${report.orphans.length} (${mb(report.orphanBytes)})${apply ? `, deleted ${report.deleted}` : ""}`);
  for (const [tenant, row] of Object.entries(report.byTenant)) console.log(`[sweep]   ${tenant}: ${row.count} (${mb(row.bytes)})`);
} finally {
  await client.end();
}
