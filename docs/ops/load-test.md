# Inbound mail load test

`scripts/load/inbound-load.mjs` sends mail through the inbound worker's own `handleEmail`
(`workers/email/src/index.ts`). It runs in Node against a real Postgres and an S3-compatible store, at a
fixed arrival rate.
- **Open loop:** messages arrive on schedule whatever the latency.
- **Pooled:** each message takes a connection from a shared pool, as Hyperdrive pools for the worker.

```sh
DATABASE_URL=postgres://… node scripts/migrate.mjs           # a scratch database
node scripts/dry-run/fake-s3.mjs 59000 &                     # or any S3 endpoint (with #117)
DATABASE_URL=postgres://… S3_ENDPOINT=http://127.0.0.1:59000 \
  npm run load:inbound -- --rate 200 --seconds 120 --mailboxes 50 --pool 20
```

## Results, 2026-11-13
Setup:
- Postgres 16 in Docker and an in-memory S3, on one sandbox machine;
- 24,000 messages (200/s for 2 min) into 50 mailboxes;
- ~2 KB plain-text messages, one recipient each;
- pool of 20;
- no live DNS (the production default).

| | stored | errors | p50 | p95 | p99 | max | peak in flight |
|---|---|---|---|---|---|---|---|
| before | 24,000 | 0 | 29.4 ms | 164.7 ms | 243.8 ms | 311.7 ms | 62 |
| after batching the blind index | 24,000 | 0 | **9.3 ms** | **29.5 ms** | **90.5 ms** | 245.0 ms | 42 |

**Hot spot:** `insertMessage` wrote each blind-index row (subject, sender, snippet, every recipient) with its own `INSERT`. That was 9 queries per message here, and 3 more for every additional recipient. Each message holds a pooled connection through all of them, and on Workers each one is a Hyperdrive round trip.

The rows now go in one `INSERT … SELECT FROM unnest(…)`. That's 6 queries per message, whatever the number of recipients.

**What this doesn't measure:**
- Cloudflare's Email Routing hand-off and the Workers runtime itself;
- Hyperdrive's network latency (the pool stands in for it);
- live SPF/DKIM DNS lookups, which are off unless `MAIL_AUTH_DNS=live`.

Expect production latency to add the network time to Supabase per query. Fewer queries matter more there than here.
