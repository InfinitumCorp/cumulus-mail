# Staging load test: 400 messages/s on Workers + Supabase

This sandbox cannot show 400/s cleanly. One Node process tops out near 250/s, and Postgres, the S3
stand-in and the load generator all share 4 vCPUs (`load-test.md`, 2026-11-18). This is the plan for
measuring it on the real stack after launch. **Never point any of it at production.**

## What is measured, and where

| Path | Production runs it on | The staging run uses |
|---|---|---|
| Inbound: parse, auth, spam, store | Email Routing → the `cumulus-mail-inbound` Worker → Hyperdrive → Supabase | `load:inbound`, which runs the Worker's own `handleEmail`, from 2–3 cloud VMs against the **staging** Supabase database and S3 bucket |
| API and pages | the `cumulus-mail-api` Worker | `soak:api -- --url https://<staging host>` |

Email Routing can't be driven over HTTP, and pushing 400 SMTP sessions a second at Cloudflare's MX
would be abuse. So the inbound run calls the same handler and pays the same Postgres and S3 cost from
outside. Supabase is the part that doesn't scale out on its own; Worker CPU does. That leaves out
Email Routing itself and Hyperdrive's pooling. The VMs' own pool (`--pool`) stands in for Hyperdrive.

## Before the run
1. A **staging** Supabase project at the same plan and compute size as production, migrated with
   `npm run db:migrate` from the commit under test. Staging is never the production project.
2. A staging S3 bucket in that project, with its own S3 access key.
3. A staging deploy of the API Worker (`soak:api` refuses the production host names).
4. 2–3 VMs with 4+ vCPUs each, in the Supabase region (us-east-1 for US), each with a checkout and
   `npm ci`.
5. Tell Supabase support about the planned load if your plan asks for that.

## Inbound, 400/s
On each of 2 VMs (200/s each), or on 1 VM with `--processes 2`:

```sh
export DATABASE_URL="postgresql://…staging…:5432/postgres?sslmode=require"   # direct, not the pooler
export S3_ENDPOINT="https://<staging-ref>.supabase.co/storage/v1/s3"
export S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… S3_BUCKET=… S3_REGION=us-east-1
export LOAD_PRODUCTION_DB_HOST="db.<production-ref>.supabase.co"   # refused even with --target staging
npm run load:inbound -- --target staging --rate 400 --seconds 300 --processes 2 --mailboxes 200 --pool 20
```

- `--target staging` is required for anything not on loopback. Without it the script exits 2.
- It also exits 2 if `DATABASE_URL` or `S3_ENDPOINT` points at `LOAD_PRODUCTION_DB_HOST`.
- Ramp the rate in steps: 100, 200, 300, 400, then 600 for headroom. Hold each step for 5 minutes.

**Pass at 400/s:** 0 errors; achieved rate within 2% of the target; p99 under 500 ms; in flight stays
flat rather than climbing. In the Supabase dashboard, CPU stays under 70% and connections stay under
the plan's limit.

**If it fails:** the error lines name the cause. Connection-limit errors mean more pool, or Supavisor
in transaction mode. Rising latency with low CPU usually means lock contention on a hot row; #162
already samples the reputation counter.

## API soak
```sh
npm run soak:api -- --url https://<staging host> --minutes 30 --concurrency 32
```

**Pass:** 0 errors, and p95 drift under 50% (last third against first). RSS isn't measured remotely;
watch the Workers dashboard's CPU time per request instead.

## After the run
The test mailboxes are named `load-<run>-<n>`. Delete them from staging with the account-deletion
path, or drop the staging project. Record the results in `load-test.md` in the same format as the
earlier runs.
