#!/usr/bin/env node
/**
 * Build the encrypted word index (migration 0011, src/lib/mail/search.ts) for messages that have none:
 * mail stored before 0011, or delivered to mailboxes nobody has opened since. Run once after applying
 * 0011 to a database that already has mail. Idempotent.
 *
 *   DATABASE_URL=... MAIL_BLOB_KEY=... node --experimental-strip-types scripts/reindex-words.mjs          # count only
 *   DATABASE_URL=... MAIL_BLOB_KEY=... node --experimental-strip-types scripts/reindex-words.mjs --apply  # write
 *
 * It writes only index rows (HMACs derived from the mail); it never changes messages.
 */
import pg from "pg";
import { readMessages } from "../src/lib/mail/records.ts";
import { reindexMissingWords } from "../src/lib/mail/search.ts";

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("[reindex] DATABASE_URL is not set");
  process.exit(1);
}
if (!process.env.MAIL_BLOB_KEY?.trim()) {
  console.error("[reindex] MAIL_BLOB_KEY is not set (needed to read the sealed messages)");
  process.exit(1);
}
const apply = process.argv.includes("--apply");
const pool = new pg.Pool({ connectionString: url, max: 2 });
try {
  const db = { query: async (text, params = []) => (await pool.query(text, params)).rows };
  const report = await reindexMissingWords(db, readMessages, { apply });
  console.log(
    `[reindex] ${apply ? "indexed" : "would index"} ${report.messages} message(s) in ${report.tenants} mailbox(es)` +
      (apply ? "" : ". Run with --apply to write."),
  );
} finally {
  await pool.end();
}
