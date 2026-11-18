#!/usr/bin/env node
/**
 * The outbound kill switch for one mailbox (docs/ops/incident.md, "Spam going out").
 *
 *   npm run outbound:pause -- --address someone@cumuluscloud.app --hours 72 --reason "Under review"
 *   npm run outbound:pause -- --address someone@cumuluscloud.app --resume
 *   npm run outbound:pause -- --list
 *
 * Pausing stops all outside sending for that mailbox, mail already in the queue included; the user
 * sees the reason on each held message. Mail inside Cumulus is not affected. Needs DATABASE_URL and
 * MAIL_BLIND_KEY (to find the mailbox by address) for the region the mailbox lives in.
 */
import pg from "pg";

import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);

/** Parse the command line, or return an error to print. */
export function parsePauseArgs(argv) {
  const get = (name) => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] ?? "" : "";
  };
  if (argv.includes("--list")) return { action: "list" };
  const address = get("--address").trim().toLowerCase();
  const tenant = get("--tenant").trim();
  if (!address && !tenant) return { error: "pass --address <mailbox address> (or --tenant <id>), or --list" };
  if (argv.includes("--resume")) return { action: "resume", address, tenant };
  const hours = Number(get("--hours") || "72");
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 365) return { error: "--hours must be between 0 and 8760" };
  return { action: "pause", address, tenant, hours, reason: get("--reason") };
}

async function main() {
  const parsed = parsePauseArgs(args);
  if (parsed.error) {
    console.error(`[pause] ${parsed.error}`);
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error("[pause] set DATABASE_URL for the mailbox's region");
    process.exit(2);
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const db = { query: async (text, params) => (await pool.query(text, params)).rows };
  try {
    if (parsed.action === "list") {
      const rows = await db.query(
        `select tenant_id, paused_until, reason from cumulus_mail.outbound_pauses where paused_until > now() order by paused_until desc`,
      );
      for (const row of rows) console.log(`${row.tenant_id}  until ${new Date(row.paused_until).toISOString()}  ${row.reason}`);
      console.log(`[pause] ${rows.length} mailbox(es) paused`);
      return;
    }
    let tenant = parsed.tenant;
    if (!tenant) {
      const { findTenantByAddress } = await import("../src/lib/mail/directory.ts");
      tenant = await findTenantByAddress(db, parsed.address);
      if (!tenant) {
        console.error(`[pause] no mailbox has the address ${parsed.address} in this region`);
        process.exit(1);
      }
    }
    const { pauseSending, resumeSending } = await import("../src/lib/mail/outbound/safety.ts");
    if (parsed.action === "resume") {
      console.log((await resumeSending(db, tenant)) ? `[pause] ${tenant}: sending resumed` : `[pause] ${tenant} was not paused`);
      return;
    }
    const until = new Date(Date.now() + parsed.hours * 3_600_000);
    await pauseSending(db, tenant, until, parsed.reason || "Sending outside Cumulus is paused while we look into unusual activity. Contact support.");
    const queued = await db.query(`select count(*) as n from cumulus_mail.outbound_queue where tenant_id = $1 and status = 'queued'`, [tenant]);
    console.log(`[pause] ${tenant}: outside sending paused until ${until.toISOString()}; ${queued[0]?.n ?? 0} queued message(s) held`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
