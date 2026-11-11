# Cumulus://Mail on Cloudflare Workers (free tier)

This file is for the operator who deploys. Nothing in this repository deploys,
creates DNS or MX records, attaches Email Routing, or writes a secret. Read
`cloudflare-handoff.md` next to it for the Supabase and migration detail; this
file is the Workers-specific part and supersedes that file's section 2 on the
Nitro preset.

Outbound mail stays held. There is no send binding and must not be one.

## Do not take over the live Worker

A Worker named **`cumulus-mail`** is already live on
**`mail.cumuluscloud.app`**. It is deployed from `infinitum-nexus/apps/cumulus-mail`,
not from this repository, and the page it serves must not change.

So `wrangler.jsonc` here names the Worker **`cumulus-mail-app`** and declares no
route, no custom domain and no `account_id`. Do not rename it to `cumulus-mail`
and do not add `mail.cumuluscloud.app` to it: either one replaces the live
Worker. Give this one its own hostname.

## One Worker, three entry points

`vite build` uses the Nitro preset `cloudflare-module`, whose handler exports
`fetch`, `scheduled` and `email`. That is the whole backend in one Worker:

| Trigger | Handler | What runs |
| --- | --- | --- |
| HTTP | `fetch` | The mailbox API — the TanStack Start server functions in `src/lib/mail/api.ts` — plus the static client out of the `ASSETS` binding and the PWA middleware in `server/middleware/`. |
| Email Routing | `email` | Nitro calls the `cloudflare:email` hook. `server/plugins/cumulus-mail-inbound.ts` answers it, opens the database and the bucket through `src/lib/mail/ingest.server.ts`, and hands the message to `handleEmail` in `workers/email/src/index.ts`. |
| Cron | `scheduled` | Nothing is registered. No cron trigger is declared. |

`workers/email/wrangler.toml.template` and the separate `cumulus-mail-inbound`
Worker it describes are no longer needed: inbound mail arrives on the same
Worker as the API, so a blob the ingest writes is read back by the API with no
second deployment to keep in step. The template stays for an operator who wants
inbound isolated on its own Worker.

### Build

```sh
npm ci
npx vite build
```

Output:

- `.output/server/index.mjs` — the Worker.
- `.output/server/wrangler.json` — `wrangler.jsonc` merged with Nitro's `main`,
  `assets` and `nodejs_compat`. This is the config to deploy with.
- `.output/public/` — the client, served through the `ASSETS` binding.

`NITRO_PRESET` overrides the preset if this app ever needs another host. There is
no Vercel output any more and `vercel.json` is gone.

Size, measured on this tree: about **1.9 MB gzipped** of JavaScript, against the
free plan's 3 MB limit. Roughly 0.75 MB of that is the PGLite WASM shim, which is
dead code on Workers (see "Database"). Aliasing `@electric-sql/pglite` to a stub
in the Cloudflare build is the lever if the bundle ever gets close to the limit.

### Deploy

```sh
npx wrangler deploy --config .output/server/wrangler.json
```

`workers_dev` is `false`, so a deployed Worker is reachable from nothing until a
hostname is added. For the smoke test, set `workers_dev` to `true` temporarily or
attach a hostname that is **not** `mail.cumuluscloud.app`.

## Database

The API and the ingest both read Postgres through `pg`, which reaches a TCP
origin from a Worker over `cloudflare:sockets` under `nodejs_compat`. Two ways
to point it at the shared Supabase Postgres, in order of preference:

1. **Hyperdrive** (free plan), which pools and caches in front of the origin:

   ```sh
   npx wrangler hyperdrive create cumulus-mail-db \
     --connection-string="postgresql://postgres.<project-ref>:<password>@<pooler-host>:5432/postgres?sslmode=require"
   ```

   Add the returned id to `wrangler.jsonc`:

   ```jsonc
   "hyperdrive": [{ "binding": "MAIL_DB", "id": "<id>" }]
   ```

   The password stays inside Hyperdrive and never reaches the Worker.

2. **`DATABASE_URL` as a secret**, the same connection string, when Hyperdrive is
   not wanted:

   ```sh
   npx wrangler secret put DATABASE_URL
   ```

`src/lib/db.ts` prefers the `MAIL_DB` binding and falls back to `DATABASE_URL`.
Both are resolved per call, not at module load, because a binding only exists
while an invocation is running.

Use pooler port **5432** (session mode). Port 6543 is transaction mode and does
not support the prepared statements this client sends.

With neither set, the app would fall back to the embedded PGLite database. That
needs a WASM build and a filesystem workerd does not have, so on Workers it
throws and names the missing setting instead.

Migrations are **not** applied by a deploy. `npm run build` in this repository no
longer chains `db:migrate`; run `node scripts/migrate.mjs` deliberately, against
an approved database, from a checkout. `migrations/rls/0006_row_level_security.sql`
is not applied by either migrator — see "Row level security".

## Storage

workerd has no local disk, so `MAIL_STORAGE=s3` is required, not optional. The
settings are already in `wrangler.jsonc` as plain vars: the Supabase project
`ivqiskeziohbbtkcvlun`, region `eu-west-1`, the private bucket `cumulus-mail`,
and `CUMULUS_ALLOW_SUPABASE=1`, which is the gate the S3 driver checks before it
will talk to any `*.supabase.co` host.

Create the bucket in the Supabase dashboard as **private**. Do not rely on
`ensureBucket()`.

## Secrets

Set each with `npx wrangler secret put NAME`. None of them is in this repository.

| Name | Role |
| --- | --- |
| `DATABASE_URL` | Only when Hyperdrive is not bound. |
| `MAIL_BLOB_KEY` | 32 bytes, hex or base64. Per-tenant AES-256-GCM for blobs and for the encrypted metadata columns. |
| `MAIL_S3_ACCESS_KEY_ID` | Supabase Storage S3 access key id. |
| `MAIL_S3_SECRET_ACCESS_KEY` | Supabase Storage S3 secret. |
| `BETTER_AUTH_SECRET` | Session signing secret. |

Plain vars that are not in `wrangler.jsonc` because they depend on the hostname
the operator picks: `BETTER_AUTH_URL`, `VITE_MAIL_DOMAIN`, `VITE_MAIL_APP_HOST`.

`CUMULUS_OIDC_ISSUER` is optional: unset, Mail verifies tokens against the
Cumulus://ID Cognito user pool. No client secret is involved — Mail verifies
tokens and never exchanges an authorization code.

## Inbound email

The Worker's `email` handler is live as soon as the Worker is deployed, but
nothing reaches it until Email Routing is attached, and nothing reaches Email
Routing until the zone has MX. Both are separate, deliberate steps and this
repository does neither.

Order:

1. Deploy the Worker with the database, the bucket and the secrets set.
2. Run the smoke test in `cloudflare-handoff.md` section 5, which injects a
   message by calling `handleEmail` directly — no MX, no Email Routing.
3. Only then publish the records in `docs/dns/spf-dkim-dmarc.template.txt`, add
   MX, set `MAIL_AUTH_DNS=live`, and route the address in Email Routing to this
   Worker.

`MAIL_AUTH_DNS` is deliberately absent from `wrangler.jsonc`: until SPF, DKIM and
DMARC are published, the inbound check must not query DNS.

If any setting is missing when a message arrives, the ingest throws with the
names of the settings it needs, the Worker logs it, and the message is not
accepted — Email Routing retries rather than silently dropping it.

## Row level security

`migrations/rls/0006_row_level_security.sql` enables row level security on every
`cumulus_mail` table and adds one owner-scoped policy each. It is **not applied**.
Neither migrator descends into a subdirectory of `migrations/`, the same way
`migrations/auth/0001_auth.sql` stays out, so applying it means copying it up
into `migrations/` on a branch and running the migrator deliberately.

Read the header of that file before applying it. In short: the app connects as
`postgres`, which has `BYPASSRLS`, so enabling RLS does not change what the
Worker can read and cannot lock the mailbox out. It closes the door on any other
connection — including the PostgREST roles — and it does **not** use
`force row level security`, which would require the app to set
`cumulus_mail.tenant_id` on every transaction first.
