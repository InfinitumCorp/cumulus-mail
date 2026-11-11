# Cloudflare handoff for Cumulus://Mail

This file is for the operator who deploys. It does not deploy anything, and it does not change DNS, MX, or Email Routing.

Outbound mail stays held. Neither worker has a `send_email` binding. Do not add one. Do not add R2.

The live Worker `cumulus-mail` (custom domain `mail.cumuluscloud.app`, the Cumulus://Mail page, its own email handler, R2 bucket `cumulus-mail-files`) is not produced by this repository. Do not deploy over that name. Do not attach `mail.cumuluscloud.app` to either worker in this tree. Do not change the Email Routing catch-all until the real-database inbound test in section 6 has passed.

## 1. Head commit

Deploy the commit that contains this file (`git rev-parse HEAD` on the pull request branch). It must descend from `552417b67b29927eccade4195a8d4642110a70f6` and it must contain `migrations/0006_mail_rls.sql` and `workers/email/wrangler.jsonc`.

```sh
git rev-parse HEAD
git merge-base --is-ancestor 552417b67b29927eccade4195a8d4642110a70f6 HEAD
test -f migrations/0006_mail_rls.sql
test -f workers/email/wrangler.jsonc
```

Do not deploy `main` by itself. Do not deploy a dirty tree. Storage is Supabase Storage bucket `cumulus-mail`. Do not use R2.

## 2. What runs where

Three pieces. They are not one Wrangler project, and none of them is the live page worker.

| Piece                  | Worker name                                  | Config                                                           | Hostname                                                                            |
| ---------------------- | -------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Inbound mail           | `cumulus-mail-inbound`                       | `workers/email/wrangler.jsonc`                                   | No workers.dev URL. No custom domain. Email Routing only, and only after section 6. |
| Mailbox API (optional) | `cumulus-mail-api`                           | `workers/api/wrangler.jsonc`, built with `npm run build:workers` | `workers.dev` only. No route on `mail.cumuluscloud.app`.                            |
| Page                   | `cumulus-mail` (already live, not this repo) | Do not touch                                                     | `mail.cumuluscloud.app` stays where it is.                                          |

`workers/email/wrangler.jsonc` has no `addresses` field on purpose. Wrangler changes Email Routing rules when that field is present. Leaving it out means a deploy of `cumulus-mail-inbound` does not take the catch-all.

The default `npm run build` still uses Nitro preset `vercel`. `NITRO_PRESET=cloudflare-module` (`npm run build:workers`) is the Workers build. It writes `.output/server/wrangler.json` for `cumulus-mail-api`. That generated file may include a Workers static-assets binding for the API worker's own URL. That binding is not R2 and it is not a custom domain. Do not add a route or a custom domain to it.

## 3. Hyperdrive

Hyperdrive is on the Workers Free plan (100,000 queries per day). Create one config and use its id in both wrangler files. Replace `REPLACE_WITH_HYPERDRIVE_ID`. Do not put the database password in git.

Origin is the Supabase session pooler, port **5432**, `sslmode=require`. Do not use port **6543** (transaction mode). The app's `pg` client uses the extended query protocol, which session mode accepts.

```sh
npx wrangler hyperdrive create cumulus-mail \
  --connection-string="postgresql://postgres.ivqiskeziohbbtkcvlun:<database-password>@<pooler-host>:5432/postgres?sslmode=require"
```

`<pooler-host>` is the host Supabase shows for the session pooler, such as `aws-0-<region>.pooler.supabase.com` or `aws-1-<region>.pooler.supabase.com`.

The Worker reads `env.HYPERDRIVE.connectionString` and passes it to `pg` with no `ssl` override and no `rejectUnauthorized: false`. The `sslmode=require` flag belongs on the origin string above. Hyperdrive's runtime string often omits it because the Worker talks to Hyperdrive, and Hyperdrive talks to Postgres.

Project ref: `ivqiskeziohbbtkcvlun`. Schema: `cumulus_mail`.

## 4. Supabase Storage

Bucket `cumulus-mail` already exists and is private. Endpoint:

```text
https://ivqiskeziohbbtkcvlun.supabase.co/storage/v1/s3
```

The driver uses `forcePathStyle: true` and checksum mode `WHEN_REQUIRED`. Object keys are `tenants/<tenantId>/<blobId>`. Bytes are AES-256-GCM under `MAIL_BLOB_KEY` before they are written. `CUMULUS_ALLOW_SUPABASE=1` is set in the wrangler vars. Without it the driver refuses `*.supabase.co`.

`SUPABASE_S3_REGION` is `us-east-1` in the wrangler file so the AWS SDK has a region. If SigV4 rejects the request, replace it with the region shown on the Supabase project. The endpoint stays the URL above.

Do not call `ensureBucket()` against this project. The bucket is already there.

## 5. Migration 0006

Migrations `0002` through `0005` are already applied. `migrations/0006_mail_rls.sql` is not. It enables row level security on every table in `cumulus_mail`, creates no policies, and revokes `anon` and `authenticated` on that schema when those roles exist. The table owner (the pooler login) keeps access. `FORCE ROW LEVEL SECURITY` is not set.

Nothing in this handoff applies it. After you approve it:

```sh
DATABASE_URL="postgresql://postgres.ivqiskeziohbbtkcvlun:<database-password>@<pooler-host>:5432/postgres?sslmode=require" \
  npm run db:migrate
```

Do not point that URL at a different project. Do not set `sslmode=disable`.

## 6. Secrets an operator must supply

No secret values belong in git. From each worker directory, `npx wrangler secret put <NAME>`.

### `cumulus-mail-inbound` (`workers/email`)

| Name                            | Kind                   | Value                                                          |
| ------------------------------- | ---------------------- | -------------------------------------------------------------- |
| Hyperdrive binding `HYPERDRIVE` | id in `wrangler.jsonc` | Id printed by `wrangler hyperdrive create`                     |
| `MAIL_BLOB_KEY`                 | secret                 | 32 bytes, hex (64 chars) or base64. Same key the API will use. |
| `SUPABASE_S3_ACCESS_KEY_ID`     | secret                 | Storage S3 access key for bucket `cumulus-mail`                |
| `SUPABASE_S3_SECRET_ACCESS_KEY` | secret                 | Storage S3 secret                                              |
| `SUPABASE_S3_ENDPOINT`          | var, already set       | `https://ivqiskeziohbbtkcvlun.supabase.co/storage/v1/s3`       |
| `SUPABASE_S3_REGION`            | var, already set       | `us-east-1` unless the project region differs                  |
| `SUPABASE_S3_BUCKET`            | var, already set       | `cumulus-mail`                                                 |
| `CUMULUS_ALLOW_SUPABASE`        | var, already set       | `1`                                                            |
| `MAIL_DOMAIN`                   | var, already set       | `cumuluscloud.app`                                             |
| `MAIL_APP_HOST`                 | var, already set       | `mail.cumuluscloud.app` (not a route)                          |

Leave `MAIL_AUTH_DNS` unset until SPF, DKIM, and DMARC are published. Unset means the handler does not query DNS.

### `cumulus-mail-api` (only if you deploy the API worker)

Same Hyperdrive id, same `MAIL_BLOB_KEY`, same two S3 secrets. Also:

| Name                      | Kind        | Value                                                                                     |
| ------------------------- | ----------- | ----------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`      | secret      | Session signing secret                                                                    |
| `BETTER_AUTH_URL`         | var you set | The `cumulus-mail-api.<account>.workers.dev` origin. Not `https://mail.cumuluscloud.app`. |
| `GROK_AUTH_CLIENT_SECRET` | secret      | Only if the app session uses that broker                                                  |

`DATABASE_URL` is not a Worker secret. The API copies `env.HYPERDRIVE.connectionString` onto `DATABASE_URL` per request. `CUMULUS_RUNTIME=cloudflare` is already a var so the Worker does not boot the local PGLite database.

OIDC defaults to the Cumulus://ID Amazon Cognito user pool:

```text
issuer:   https://cognito-idp.us-east-1.amazonaws.com/us-east-1_fRlMO7dna
jwks_uri: https://cognito-idp.us-east-1.amazonaws.com/us-east-1_fRlMO7dna/.well-known/jwks.json
```

Discovery is `/.well-known/openid-configuration` under the issuer, and Mail reads `jwks_uri` from it. Name another pool with `CUMULUS_COGNITO_USER_POOL_ID` (and `CUMULUS_COGNITO_REGION` when it is not the prefix of the pool id), or any other OIDC issuer with `CUMULUS_OIDC_ISSUER`; override the JWKS URL with `CUMULUS_OIDC_JWKS_URL`. The tenant is the verified `tenant_id` claim (`custom:tenant_id`, or the verified `sub` for a user pool that mints neither). The retired Keycloak realm `https://id.cumuluscloud.app/realms/cumulus` no longer answers and is not the default.

## 7. Deploy steps

Confirm the account before any command that talks to Cloudflare. `npx wrangler whoami` must be the account that already owns `cumulus-mail`. If it is not, stop.

1. Apply migration 0006 (section 5) after it is approved.
2. Create the Hyperdrive config (section 3). Paste the id over `REPLACE_WITH_HYPERDRIVE_ID` in `workers/email/wrangler.jsonc`. Do the same in `workers/api/wrangler.jsonc` only if you are deploying the API.
3. Put the three inbound secrets (section 6). Do not put them in `[vars]` or in git.

```sh
cd workers/email
npx wrangler secret put MAIL_BLOB_KEY
npx wrangler secret put SUPABASE_S3_ACCESS_KEY_ID
npx wrangler secret put SUPABASE_S3_SECRET_ACCESS_KEY
npx wrangler deploy
```

`wrangler deploy` here creates or updates **`cumulus-mail-inbound` only**. It does not change Email Routing, because `addresses` is absent. It does not touch worker `cumulus-mail`.

The same worker can be uploaded with the Cloudflare API from `npm run build:inbound`. That command writes two files and does not call Cloudflare:

| File                         | Role                                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dist/inbound/index.js`      | One bundled ESM module. This is the main module.                                                                                                       |
| `dist/inbound/metadata.json` | Script-upload metadata: `main_module` `index.js`, `compatibility_date` `2026-11-10`, `compatibility_flags` `["nodejs_compat"]`, and the bindings list. |

The bindings list is Hyperdrive `HYPERDRIVE` (id still `REPLACE_WITH_HYPERDRIVE_ID` until you edit a copy), the plain-text vars from `workers/email/wrangler.jsonc`, and three `secret_text` names with no `text` field: `MAIL_BLOB_KEY`, `SUPABASE_S3_ACCESS_KEY_ID`, `SUPABASE_S3_SECRET_ACCESS_KEY`. Copy `metadata.json` aside, replace the Hyperdrive id, and add `text` on each secret binding. Do not commit that copy.

There is no `send_email` binding, no R2 binding, and no route. The upload does not attach `mail.cumuluscloud.app` and does not change the Email Routing catch-all.

```sh
npm run build:inbound
# edit a copy of dist/inbound/metadata.json with the Hyperdrive id and secret text
curl -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/cumulus-mail-inbound" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -F "metadata=@/tmp/cumulus-mail-inbound-metadata.json;type=application/json" \
  -F "index.js=@dist/inbound/index.js;type=application/javascript+module"
```

The script name in that URL is `cumulus-mail-inbound`. Do not PUT this module onto the script name `cumulus-mail`. The API token needs Workers Scripts write permission. This handoff does not run the curl.

4. Run the real-database probe (section 8) from a checkout, before any routing change. The probe uses the same pooler URL you gave Hyperdrive and the same S3 key. It is not a substitute for reading the Worker logs, but it runs `handleEmail` through the Hyperdrive/S3 wiring.
5. Only after that probe passes, in the Cloudflare dashboard for the zone `cumuluscloud.app`, change the Email Routing **catch-all** from worker `cumulus-mail` to worker `cumulus-mail-inbound`. Do not add an MX record as part of this step. MX already points wherever it points today. This handoff does not edit DNS.
6. Send one message to an address that already has a mailbox. Confirm the Worker log event `mail.inbound.stored`, an encrypted `cumulus_mail.messages` row, and a ciphertext object at `tenants/<tenantId>/<blobId>`.
7. Optional API worker, separate from the page:

```sh
npm run build:workers
npx wrangler deploy --config .output/server/wrangler.json
```

The generated worker name is `cumulus-mail-api`. `main` is `index.mjs` next to that config, and the static assets directory is the build output for this worker's own `workers.dev` URL. If the generated config's name is anything else, or if it contains `routes` or `send_email`, stop. Do not add a custom domain. Do not set `routes` to `mail.cumuluscloud.app`. Call the API on `https://cumulus-mail-api.<account>.workers.dev`.

## 8. Smoke and the real-database probe

`node scripts/smoke.mjs` with no Supabase variables prints four skip lines (storage, database, oidc, inbound) and exits 0. CI runs it that way. It does not contact Supabase or the identity host.

After 0006 is applied and the bucket credentials are available:

```sh
export DATABASE_URL="postgresql://postgres.ivqiskeziohbbtkcvlun:<database-password>@<pooler-host>:5432/postgres?sslmode=require"
export CUMULUS_ALLOW_SUPABASE=1
export CUMULUS_OIDC_ISSUER="https://cognito-idp.us-east-1.amazonaws.com/us-east-1_fRlMO7dna"
export MAIL_S3_ENDPOINT="https://ivqiskeziohbbtkcvlun.supabase.co/storage/v1/s3"
export MAIL_S3_BUCKET="cumulus-mail"
export MAIL_S3_REGION="us-east-1"
export MAIL_S3_ACCESS_KEY_ID="<access key id>"
export MAIL_S3_SECRET_ACCESS_KEY="<secret>"
node --experimental-strip-types scripts/smoke.mjs
```

`SUPABASE_S3_*` is accepted as an alias for `MAIL_S3_*`.

The inbound probe stays off unless you set `MAIL_INBOUND_LIVE=1`. It creates a throwaway tenant, runs `handleEmail` on one RFC822 message, checks that the subject and the blob are ciphertext, then deletes the row and the object.

```sh
export MAIL_INBOUND_LIVE=1
export HYPERDRIVE_CONNECTION_STRING="$DATABASE_URL"
export MAIL_BLOB_KEY="<same 32-byte key>"
export SUPABASE_S3_ENDPOINT="$MAIL_S3_ENDPOINT"
export SUPABASE_S3_REGION="$MAIL_S3_REGION"
export SUPABASE_S3_BUCKET="cumulus-mail"
export SUPABASE_S3_ACCESS_KEY_ID="$MAIL_S3_ACCESS_KEY_ID"
export SUPABASE_S3_SECRET_ACCESS_KEY="$MAIL_S3_SECRET_ACCESS_KEY"
node --experimental-strip-types scripts/smoke.mjs
```

`scripts/inbound-live.mjs` is the same probe. With the flag unset it exits 0. A non-local URL must use port 5432 and `sslmode=require`. Do not set `MAIL_AUTH_DNS`. Do not set `MAIL_S3_LOOPBACK_ONLY`.

## 9. Outbound mail

Outbound mail stays held.

- Mail to a non-Cumulus address stays in the sender's outbox. It is not sent.
- Do not add `send_email` to either wrangler file.
- Do not add an Email Routing destination that forwards or sends.
- Do not add `addresses` to `workers/email/wrangler.jsonc` unless you have decided to move the catch-all and you understand that the next deploy will change the live routing rules.
