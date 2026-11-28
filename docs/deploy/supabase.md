# Supabase as the database and blob store

Cumulus://Mail runs on Postgres and on S3-compatible object storage. Supabase provides both.
The code needs no Supabase SDK: `pg` talks to Postgres and AWS SDK v3 talks to Storage's S3 endpoint.

## Projects

| Use | Project | Ref | Region |
| --- | --- | --- | --- |
| Production (shared, via Hyperdrive) | Infinitum Corp | `ivqiskeziohbbtkcvlun` | eu-west-1 |
| Integration tests | cumulus-mail (free plan) | `percackrrhhreusasspr` | us-east-1 |

The integration tests re-apply every migration and write test mailboxes. They refuse the
production ref. Point them only at the test project.

On the test project the login role `cumulus_mail_ci` owns the `cumulus_mail` schema, the
`_migrations` table and every table. The migrations' RLS step needs the owner. The private
bucket `cumulus-mail` already exists.

## Database

- Use the **session pooler**:
  `postgresql://<user>.<ref>:<password>@aws-<n>-<region>.pooler.supabase.com:5432/postgres`.
  It is IPv4 and keeps session state. The direct host `db.<ref>.supabase.co` is IPv6-only on the
  free plan.
- The **transaction pooler** (port 6543) is only for short serverless queries. Do not run
  migrations through it.
- TLS: `pg` 8.x treats `sslmode=require` as `verify-full`. Add
  `&sslrootcert=/path/to/prod-ca-2021.crt` (Supabase Root 2021 CA, from the Supabase dashboard
  under Database > Settings > SSL Configuration). Never disable certificate checks.
  `src/lib/pg-connection.ts` refuses `sslmode=disable` for non-local hosts.
- Migrations: `DATABASE_URL=... npm run db:status` lists pending files (exit 3).
  `npm run db:migrate` applies them.
- Workers reach production through Hyperdrive (`<id>.hyperdrive.local`). Hyperdrive makes the TLS
  connection to the session pooler.

## Storage (S3)

- Endpoint: `https://<ref>.storage.supabase.co/storage/v1/s3`. Region: the project's region.
- `createS3Driver` sets `forcePathStyle: true` and `WHEN_REQUIRED` checksums. Supabase needs both.
- Set `CUMULUS_ALLOW_SUPABASE=1` and `MAIL_S3_LOOPBACK_ONLY=0`, or the driver refuses the host.
- S3 access keys exist only in the dashboard: Storage > S3 Configuration > Access keys.
  They bypass RLS. Keep them server-side.
- Every blob is sealed with `MAIL_BLOB_KEY` before upload.

## Running the integration tests against the test project

```sh
set -a; . ~/.secrets/cumulus-mail/supabase.env; set +a   # git-ignored, chmod 600, outside the repo
node --experimental-strip-types --test --test-concurrency=1 \
  src/lib/storage/s3.integration.test.ts src/lib/mail/inbound-runtime.test.ts
```

The runner needs outbound TCP to the pooler on port 5432 and HTTPS to the Storage endpoint.
