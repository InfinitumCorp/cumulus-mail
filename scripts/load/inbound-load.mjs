#!/usr/bin/env node
/**
 * Load test of inbound mail: the inbound worker's own handleEmail (workers/email/src/index.ts), run in
 * Node against a real Postgres and an S3-compatible store, at a fixed arrival rate.
 *
 *   DATABASE_URL=postgres://… S3_ENDPOINT=http://127.0.0.1:59000 \
 *   node --experimental-strip-types scripts/load/inbound-load.mjs --rate 200 --seconds 120
 *
 * Open loop: messages are sent on schedule whatever the latency, as mail arrives. Each message takes a
 * connection from a shared pool, the way Hyperdrive pools for the worker. Reports p50/p95/p99, errors
 * and the peak number in flight. The schema must be migrated (scripts/migrate.mjs). Sender
 * authentication uses the default (no live DNS), as in production unless MAIL_AUTH_DNS=live.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const RATE = Number(arg("rate", "200"));
const SECONDS = Number(arg("seconds", "120"));
const MAILBOXES = Number(arg("mailboxes", "50"));
const POOL = Number(arg("pool", "20"));
const DATABASE_URL = process.env.DATABASE_URL;
const S3_ENDPOINT = process.env.S3_ENDPOINT;
if (!DATABASE_URL || !S3_ENDPOINT) {
  console.error("Set DATABASE_URL and S3_ENDPOINT (see the header of this file).");
  process.exit(1);
}

process.env.MAIL_BLOB_KEY ??= randomBytes(32).toString("hex");
process.env.MAIL_DOMAIN = "cumuluscloud.app";
const { handleEmail } = await import("../../workers/email/src/index.ts");
const { openMailbox } = await import("../../src/lib/mail/mailbox.ts");

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: POOL });
const query = async (text, params) => (await pool.query(text, params)).rows;

const run = Date.now().toString(36);
const tenants = Array.from({ length: MAILBOXES }, (_, i) => `load-${run}-${i}`);
for (const tenant of tenants) {
  await openMailbox({ query }, tenant, { name: tenant, email: `${tenant}@cumuluscloud.app`, cid: `cid:${tenant}`, plan: "Free", quotaGb: 15 });
}

const env = {
  HYPERDRIVE: { connectionString: "postgres://load@pool.invalid:5432/db" },
  SUPABASE_S3_ENDPOINT: S3_ENDPOINT,
  SUPABASE_S3_REGION: "us-east-1",
  SUPABASE_S3_ACCESS_KEY_ID: "load",
  SUPABASE_S3_SECRET_ACCESS_KEY: "load",
  SUPABASE_S3_BUCKET: "cumulus-mail-load",
  MAIL_S3_LOOPBACK_ONLY: "1",
  CUMULUS_ALLOW_SUPABASE: "1",
  MAIL_BLOB_KEY: process.env.MAIL_BLOB_KEY,
  MAIL_DOMAIN: "cumuluscloud.app",
  ingestHooks: {
    // Hyperdrive stands in front of Postgres with a pool; so does this.
    async connect() {
      const client = await pool.connect();
      return { query: async (text, params) => (await client.query(text, params)).rows, end: async () => client.release() };
    },
  },
};

const body = "Hello,\r\n\r\n" + "This is a load test message with a few lines of ordinary text.\r\n".repeat(30);
const raw = (n, to) =>
  new TextEncoder().encode(
    [
      `From: Sender ${n % 97} <sender${n % 97}@example.org>`,
      `To: <${to}>`,
      `Subject: Load test ${n}`,
      `Message-ID: <${run}.${n}@example.org>`,
      `Date: ${new Date().toUTCString()}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      `${body}#${n}`,
    ].join("\r\n"),
  );

const latencies = [];
let errors = 0;
const errorKinds = new Map();
let inFlight = 0;
let peak = 0;
const total = RATE * SECONDS;
const started = performance.now();
const done = [];
console.log(`[load] ${total} messages at ${RATE}/s for ${SECONDS}s into ${MAILBOXES} mailboxes, pool ${POOL}`);
for (let n = 0; n < total; n += 1) {
  const due = started + (n * 1000) / RATE;
  const wait = due - performance.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const to = `${tenants[n % MAILBOXES]}@cumuluscloud.app`;
  inFlight += 1;
  peak = Math.max(peak, inFlight);
  const t0 = performance.now();
  done.push(
    handleEmail({ from: `sender${n % 97}@example.org`, to, raw: raw(n, to) }, env)
      .then((r) => {
        if (!r.stored?.length) throw new Error("not stored");
        latencies.push(performance.now() - t0);
      })
      .catch((e) => {
        errors += 1;
        const kind = String(e?.message ?? e).slice(0, 80);
        errorKinds.set(kind, (errorKinds.get(kind) ?? 0) + 1);
      })
      .finally(() => {
        inFlight -= 1;
      }),
  );
  if (n > 0 && n % (RATE * 10) === 0) console.log(`[load] ${Math.round((performance.now() - started) / 1000)}s: sent ${n}, in flight ${inFlight}, errors ${errors}`);
}
await Promise.all(done);
const elapsed = (performance.now() - started) / 1000;
latencies.sort((a, b) => a - b);
const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))]?.toFixed(1);
console.log(`[load] done in ${elapsed.toFixed(1)}s: ${latencies.length} stored, ${errors} errors, ${(latencies.length / elapsed).toFixed(1)}/s achieved, peak in flight ${peak}`);
console.log(`[load] latency ms: p50 ${pct(50)}  p95 ${pct(95)}  p99 ${pct(99)}  max ${latencies.at(-1)?.toFixed(1)}`);
for (const [kind, count] of errorKinds) console.log(`[load]   error x${count}: ${kind}`);
await pool.end();
process.exit(errors ? 1 : 0);
