#!/usr/bin/env node
/**
 * `npm run keys:rekey`: move stored fields and blobs to the current key in MAIL_BLOB_KEYS
 * (src/lib/storage/rekey.ts; docs/ops/runbook.md, "Rotating MAIL_BLOB_KEY").
 *
 * Dry run by default. Needs DATABASE_URL, MAIL_BLOB_KEYS (current key first, every old key after it)
 * and the same storage settings as the app (MAIL_STORAGE, MAIL_S3_* or MAIL_BLOB_DIR).
 * Exit codes: 0 everything is under the current key (after --apply) or the dry run finished;
 * 1 error; 2 values remain that could not be re-sealed (see "failed"; re-run, or find the missing key).
 */
import pg from "pg";
import { USAGE, parseRekeyArgs } from "./rekey-args.mjs";

let options;
try {
  options = parseRekeyArgs(process.argv.slice(2));
} catch (error) {
  console.error(`[keys:rekey] ${error.message}\n\n${USAGE}`);
  process.exit(1);
}
if (options.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!process.env.DATABASE_URL) {
  console.error("[keys:rekey] DATABASE_URL is not set");
  process.exit(1);
}
if (!process.env.MAIL_BLOB_KEYS) {
  console.error("[keys:rekey] MAIL_BLOB_KEYS is not set: list the new key first, then every old key (see the runbook)");
  process.exit(1);
}

const { keyringFromEnv } = await import("../src/lib/storage/keyring.ts");
const { createStorageDriver } = await import("../src/lib/storage/index.ts");
const { rekey, notYetCurrent } = await import("../src/lib/storage/rekey.ts");

const ring = keyringFromEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const db = { query: async (text, params) => (await pool.query(text, params)).rows };
const line = (r) =>
  `mailboxes ${r.mailboxes} (last ${r.lastTenant ?? "-"}) | fields ${r.fields.scanned} scanned, ${r.fields.resealed} re-sealed, ${r.fields.failed} failed | blobs ${r.blobs.scanned} scanned, ${r.blobs.resealed} re-sealed, ${r.blobs.failed} failed, ${r.blobs.missing} missing`;

console.log(`[keys:rekey] ${options.apply ? "APPLY" : "dry run (add --apply to re-seal)"}; current key ${ring.current}; keys ${[...ring.keys.keys()].join(", ")}`);
try {
  const report = await rekey(db, createStorageDriver(), ring, {
    apply: options.apply,
    batchSize: options.batchSize,
    fromTenant: options.fromTenant,
    onProgress: (r) => console.log(`[keys:rekey] ${line(r)}`),
  });
  console.log(`[keys:rekey] done: ${line(report)}`);
  console.log(`[keys:rekey] fields by key ${JSON.stringify(report.fields.byKey)}; blobs by key ${JSON.stringify(report.blobs.byKey)}`);
  const remaining = notYetCurrent(report);
  if (!options.apply) {
    console.log(`[keys:rekey] ${remaining} value(s) would be re-sealed`);
  } else if (remaining === 0) {
    console.log("[keys:rekey] every value is under the current key; old keys can be removed after a verification run");
  } else {
    console.log(`[keys:rekey] ${remaining} value(s) are still not under the current key; re-run (it is safe) and check "failed"`);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`[keys:rekey] stopped: ${error.message}. Resume with --from-tenant <last mailbox printed above>.`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
