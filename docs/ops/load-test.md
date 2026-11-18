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

## Results, 2026-11-16 (launch check)
Same setup as 13 Nov: Postgres 16 and the in-memory S3 on one sandbox machine, 200 messages/s into 50
mailboxes, pool of 20. This time **each run gets a fresh database and a fresh S3 stand-in**: a long-lived
stand-in holding earlier runs' objects in memory made later runs look several times slower than they were.

| code | stored | errors | p50 | p95 | p99 | max |
|---|---|---|---|---|---|---|
| `main` 22be155, run 1 | 12,000 | 0 | 8.9 ms | 31.9 ms | 111.7 ms | 190.7 ms |
| `main` 22be155, run 2 | 12,000 | 0 | 9.2 ms | 47.4 ms | 166.2 ms | 221.3 ms |
| main + the launch PRs, run 1 | 12,000 | 0 | 8.4 ms | 39.1 ms | 187.3 ms | 260.2 ms |
| main + the launch PRs, run 2 | 12,000 | 0 | 8.2 ms | 103.7 ms | 240.7 ms | 311.1 ms |

No errors and no regression in the median (8–9 ms against 9.3 ms on 13 Nov). The tail is wider than 13 Nov,
and varies a lot between identical runs on this shared machine; the inbound spam checks (#106) add three
small queries per message (the sender domain's reputation, the mailbox's lists).

**One hot row per big sending domain (handled):** every authenticated message from a domain counts toward
that domain's one `sender_reputation` row (`received`). It held up in the 13 Nov run (58,000 updates to one
row, few dead tuples thanks to HOT updates and autovacuum). Since #146 only DMARC-passing mail counts, so this
script (no live DNS) no longer touches that row; it was measured directly on 18 Nov (below). Since then, a
domain past 1,000 messages is counted by
sampling (`countReceived` in `src/lib/mail/spam.ts`: one message in 16, at random, adds 16), so a
gmail.com-sized sender writes that row about 1/16 as often. The expected count is unchanged; the count is
only compared with spam votes at 0.1%.

The script now creates the bucket itself when `S3_ENDPOINT` is a loopback stand-in (before, the recipe
above failed every message with an opaque `UnknownError`).

## Results, 2026-11-18 (twice the launch rate)
Same machine: **4 vCPUs**, shared by Postgres 16, the S3 stand-in and the load generators. Production code
of `main` plus the open launch PRs. Fresh database and S3 stand-in per run.

**The hot reputation row, directly** (400 messages/s for 60 s, all from one domain, the reputation read plus
the count, pool 20, open loop):

| | row writes | p50 | p95 | p99 | max | peak in flight | `received` after 24,000 |
|---|---|---|---|---|---|---|---|
| every message (before #162) | 24,000 | 1.2 ms | 12.0 ms | 106.5 ms | 319 ms | 109 | 24,000 |
| sampled (#162) | 1,469 | 0.4 ms | 1.7 ms | 4.4 ms | 86 ms | 30 | 23,504 (−2%) |

**The whole inbound path at 400/s:**

| setup | offered | achieved | stored | errors | p50 | p99 | peak in flight |
|---|---|---|---|---|---|---|---|
| one load process, new MIME parser (#167) | 400/s, 60 s | 238.6/s | 24,000 | 0 | 22.1 s | 40.2 s | 10,139 |
| one load process, old MIME parser | 400/s, 60 s | 249.5/s | 24,000 | 0 | 18.3 s | 35.8 s | 9,110 |
| two load processes at 200/s each | 400/s, 120 s | ~381/s combined | 48,000 | 0 | 4.8–6.0 s | 5.4–6.7 s | 1,068–1,350 |

- One process tops out at about 240–250/s, with the old parser and the new one alike: the ceiling is one Node
  thread running the generator and the handler, not the code under test.
- Two processes (closer to Workers, where every message is its own invocation) store everything, **0 errors
  and nothing lost**, but queue: this 4-core box, also running Postgres and the S3 stand-in, cannot show
  400/s cleanly. 200/s (about 17 M messages a day) stays at p50 9 ms (16 Nov).
- **Open:** a 400/s figure on real infrastructure (Workers + Hyperdrive + Supabase) needs a staging run.

# API soak

`npm run soak:api -- --minutes 30 --concurrency 8` (`scripts/load/api-soak.mjs`) starts the **production
build** (`.output/server`, CSP enforced) itself and keeps 8 requests in flight for the whole run, cycling
through:
- the server-rendered app;
- `/api/health?deep=1`;
- the 404 page;
- a refused export link;
- a CSP report.

Every minute it prints requests, errors, p50/p95/p99 and the server's RSS. At the end it compares the last
third of the run with the first (after a warm-up minute, and leaving out a partial last minute) and fails
on RSS growth over 25%, p95 growth over 50%, or any error. It looks for **drift** (a leak, a growing
cache), not peak throughput. Set `DATABASE_URL` to use Postgres; otherwise it uses PGlite.

## Results, 2026-11-17 (launch check)
Production build of `main` plus the launch PRs (#146–#152), Postgres 16, one sandbox machine, 30 minutes.

| minute | requests | errors | p50 | p95 | p99 | RSS |
|---|---|---|---|---|---|---|
| 1 | 54,958 | 0 | 8 ms | 16 ms | 21 ms | 505 MB |
| 10 | 60,384 | 0 | 7 ms | 14 ms | 18 ms | 515 MB |
| 20 | 59,241 | 0 | 7 ms | 15 ms | 20 ms | 517 MB |
| 30 | 61,148 | 0 | 7 ms | 14 ms | 19 ms | 519 MB |

**1,798,401 requests, 0 errors. Last third against the first: RSS +1.0%, p95 −3.0%.** No leak and no
latency drift. RSS settles at about 515 MB within the first two minutes. (With PGlite instead of Postgres,
RSS is higher, about 930 MB, because the database runs inside the process.)

## Results, 2026-11-18 (twice the concurrency)
`npm run soak:api -- --minutes 15 --concurrency 16`, the production build of `main` plus the open launch PRs,
Postgres 16, the same 4-vCPU machine.

| minute | requests | errors | p50 | p95 | p99 | RSS |
|---|---|---|---|---|---|---|
| 1 | 48,630 | 0 | 17 ms | 35 ms | 50 ms | 521 MB |
| 5 | 50,387 | 0 | 16 ms | 34 ms | 46 ms | 523 MB |
| 10 | 50,210 | 0 | 16 ms | 34 ms | 46 ms | 530 MB |
| 15 | 46,218 | 0 | 18 ms | 39 ms | 51 ms | 530 MB |

**748,875 requests, 0 errors. Last third against the first: RSS +1.4%, p95 +4.4%.** No leak and no drift.
Throughput is the same as at concurrency 8 (about 50,000 a minute: the machine is CPU-bound), so doubling the
concurrency doubles latency (p95 34 ms against 14 ms) rather than adding errors.
