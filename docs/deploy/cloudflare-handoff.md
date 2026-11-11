# Cloudflare handoff for Cumulus://Mail

This file is for the operator who deploys. It does not deploy anything, and it does not change DNS or MX.

Outbound mail stays held. The inbound worker has no send binding. Do not add one.

## 1. Head commit

Deploy the head of branch `cursor/mail-inbound-runtime-5933` (pull request 6).

After you fetch the branch, the exact head is `git rev-parse HEAD`. It must contain this handoff:

```sh
git rev-parse HEAD
git merge-base --is-ancestor f597369740e9f97837417b88a034a394d3e84ae8 HEAD
```

The ancestor check must succeed. Do not deploy `main` or an older preview commit. Do not deploy from a tree that has uncommitted edits. Storage in this handoff is Supabase Storage. Do not use R2.

## 2. What runs where

Three pieces. They are not one Wrangler project today.

### API

The mailbox API is the TanStack Start server functions in `src/lib/mail/api.ts`: read and write the mailbox, read an attachment, export and import, abuse intake, delivery-status intake, and share links. The tenant comes from the verified session or from a verified Cumulus token (`tenant_id`). It is never taken from the request body.

`vite.config.ts` builds that server with Nitro preset `vercel`. That preset does not produce a Cloudflare Worker. For Workers, change the Nitro preset to `cloudflare-module` and deploy that output as the API Worker. Leave the preset change and the deploy to the operator. This handoff does not make that change.

The API reads Postgres through `DATABASE_URL` (`src/lib/db.ts`, package `pg`). On Workers, `pg` cannot open a raw socket to Postgres. Use the free Cloudflare Hyperdrive plan in front of the shared Supabase Postgres, and set `DATABASE_URL` to that Hyperdrive binding's connection string before the app reads it. Hyperdrive is the adapter that matches this code. Details are in section 3.

D1 is not a substitute. The schema is Postgres (`cumulus_mail`, including `create schema` and `timestamptz`). Those files do not run on D1 without a port that this tree does not contain.

Do not run `npm run db:migrate` against the shared database until the migrations in section 3 are approved. With `DATABASE_URL` unset, that command skips. The embedded PGLite database is only the local fallback. Do not use it for this deploy.

`VITE_AUTH_ENABLED=false` together with `DATABASE_URL` refuses every request. A real database requires auth on, plus the Better Auth variables in the table below.

### Inbound email

`workers/email/src/index.ts` exports `email(message, env)`. That is the handler Cloudflare Email Routing and Email Workers call. The Wrangler file is `workers/email/wrangler.toml.template`.

The template is not a deploy:

- Worker name in the template: `cumulus-mail-inbound`
- `workers_dev = false`
- no `account_id`
- no route
- no send binding
- no secrets

`email()` stores a message only when `env.ingest` is set to `{ db, storageFor }` using the same query and storage interface as the API. If `ingest` is missing, the handler throws and stores nothing. The template does not declare that binding. Wire Hyperdrive and Supabase Storage into `ingest` before any mail is attached to the worker. Do not declare an MX or an Email Routing route until the smoke test below has passed.

The handler accepts a recipient only when the address ends with `MAIL_DOMAIN` (default `cumuluscloud.app`). SPF, DKIM, and DMARC run only when `MAIL_AUTH_DNS=live`. Leave that unset for the smoke test so the worker does not query DNS.

### Static UI

The browser UI is the Vite client. It loads the mailbox by calling the API (`getMailbox` and `getAttachment`). Put the built static files on Cloudflare Pages or on Workers Assets. Point them at the API Worker. A Pages or Workers Assets host by itself has no mailbox.

The web host the app expects is `mail.cumuluscloud.app` (`MAIL_APP_HOST` / `VITE_MAIL_APP_HOST`). A `pages.dev` or workers hostname is enough for the smoke test. Do not add MX to make the UI load.

## 3. Supabase Storage and Postgres

No R2. Blob bytes and the mailbox database both stay on the free Supabase project. Cloudflare is only Hyperdrive, the API Worker, and the static host.

### Storage

Use the existing S3 driver (`MAIL_STORAGE=s3`). It is AWS SDK v3. For Supabase Storage set:

| Setting | Value |
| --- | --- |
| `MAIL_S3_ENDPOINT` | `https://<project>.supabase.co/storage/v1/s3` |
| `MAIL_S3_REGION` | the project region, for example the region shown for that project |
| `MAIL_S3_BUCKET` | a private bucket used only by Mail, such as `cumulus-mail` |
| `CUMULUS_ALLOW_SUPABASE` | `1` |
| `MAIL_S3_LOOPBACK_ONLY` | unset. `1` refuses every host that is not loopback |
| Path style | already `forcePathStyle: true`, so the bucket stays on the path under `/storage/v1/s3` |
| Checksums | already `WHEN_REQUIRED` for both request and response. The default AWS SDK flexible checksums are not accepted by this endpoint |

`<project>` is the Supabase project ref. The driver refuses every `*.supabase.co` host until `CUMULUS_ALLOW_SUPABASE=1`. That flag is the gate. Leave it unset until this project is the one you mean to use. Do not point the endpoint at a second Supabase project.

Create the bucket in the Supabase dashboard as private. Do not rely on `ensureBucket()`. If `MAIL_S3_BUCKET` is unset, the code uses `cumulus-mail-preview`. Set the name explicitly.

Object key, for every attachment and every raw MIME blob:

```text
tenants/<tenantId>/<blobId>
```

`tenantId` matches `[A-Za-z0-9_-]{1,80}`. `blobId` is 32 lowercase hex characters. A read for a different tenant id is a different key, so it does not return the object. The bytes in the bucket are AES-256-GCM ciphertext. The plaintext SHA-256 stays in Postgres.

The API and `env.ingest.storageFor` must use this same driver and bucket. A blob written by the inbound handler is read by the API.

The access key and secret are a Supabase Storage S3 key with object read and write on that one bucket. They are `MAIL_S3_ACCESS_KEY_ID` and `MAIL_S3_SECRET_ACCESS_KEY`.

### Database

Hyperdrive's origin is the shared Supabase Postgres pooler, not a new database. Configure Hyperdrive with this origin string. Do not put this string in the Worker. The password stays in Hyperdrive.

```text
postgresql://postgres.<project-ref>:<database-password>@<pooler-host>:5432/postgres?sslmode=require
```

`<pooler-host>` is the host Supabase shows for the pooler, such as `aws-0-<region>.pooler.supabase.com` or `aws-1-<region>.pooler.supabase.com`.

Use pooler port **5432** (session mode). Hyperdrive already pools. This app's `pg` pool speaks the extended query protocol, which session mode accepts. Port **6543** is transaction mode. Do not use it. Transaction mode does not support the prepared statements this client sends.

SSL is `sslmode=require`. `src/lib/db.ts` passes that connection string to `pg` and does not disable certificate checks. Do not set `sslmode=disable` or `rejectUnauthorized: false`.

On the Worker, `DATABASE_URL` is the Hyperdrive binding's connection string, not the Supabase URL above.

### Migrations that need approval

Nothing in this handoff applies them. `npm run db:migrate` writes them when `DATABASE_URL` is set. Do not run it until these five files are approved for the shared database:

| File | What it changes |
| --- | --- |
| `migrations/0002_cumulus_mail.sql` | Creates schema `cumulus_mail` and the mailbox tables. |
| `migrations/0003_mail_auth_share.sql` | Adds `messages.auth_json` and `share_grants`. |
| `migrations/0004_message_metadata.sql` | Adds snippet and header columns and the blind-index tables. |
| `migrations/0005_profile_and_routes.sql` | Adds `address_routes` and drops the global address index. |
| `migrations/0006_parity_settings.sql` | Adds sealed mailbox settings, message extras, contact private fields, and password-protected links. |

`migrations/auth/0001_auth.sql` is not in that list. The migrator does not apply it unless it is copied into `migrations/`. Approving the five files above does not approve the auth schema.

## 4. Environment variables

No values belong in this file. Mark secret names as secrets in the Worker and in Pages. Plain names can be `[vars]`.

### Required for the API and for ingest

| Name | Kind | Role |
| --- | --- | --- |
| `DATABASE_URL` | secret | Hyperdrive connection string for the shared Supabase Postgres. Not the pooler URL. Auth refuses to start against a real database when sign-in is off. |
| `MAIL_BLOB_KEY` | secret | 32 bytes, hex (64 chars) or base64. Per-tenant AES-256-GCM for blobs, subjects, addresses, snippets, headers, display names, signatures, and authentication results. |
| `MAIL_STORAGE` | plain | `s3` for Supabase Storage. Unset means local disk, which Workers do not have. |
| `MAIL_S3_BUCKET` | plain | Private Mail-only bucket name. |
| `MAIL_S3_ENDPOINT` | plain | `https://<project>.supabase.co/storage/v1/s3`. The project ref in the host is account configuration, not a key. |
| `MAIL_S3_REGION` | plain | The Supabase project region. Unset selects `us-east-1`. |
| `MAIL_S3_ACCESS_KEY_ID` | secret | Supabase Storage S3 access key id. |
| `MAIL_S3_SECRET_ACCESS_KEY` | secret | Supabase Storage S3 secret. |
| `CUMULUS_ALLOW_SUPABASE` | plain | Must be `1` before the driver will use a `*.supabase.co` endpoint. Unset refuses the host. |
| `MAIL_DOMAIN` | plain | `cumuluscloud.app`. Also a `[vars]` entry on the inbound worker. |
| `MAIL_APP_HOST` | plain | `mail.cumuluscloud.app`. Also a `[vars]` entry on the inbound worker. |
| `VITE_MAIL_DOMAIN` | plain | Same domain, baked into the browser build. |
| `VITE_MAIL_APP_HOST` | plain | Same host, baked into the browser build. |
| `VITE_AUTH_ENABLED` | plain | `true` for this deploy. `false` with `DATABASE_URL` set fails closed. |
| `BETTER_AUTH_SECRET` | secret | Session signing secret. |
| `BETTER_AUTH_URL` | plain | Public origin of the API, `https://mail.cumuluscloud.app` once that host exists. |
| `CUMULUS_OIDC_ISSUER` | plain | Any OIDC issuer, used verbatim. Unset, Mail uses the Cumulus://ID Cognito user pool `https://cognito-idp.us-east-1.amazonaws.com/us-east-1_fRlMO7dna`. A bearer whose issuer matches is verified against that issuer's keys, and the tenant is the verified `tenant_id` claim (`custom:tenant_id`, or the verified `sub` for a user pool that mints neither). |
| `CUMULUS_COGNITO_USER_POOL_ID` | plain | Names another Cognito user pool instead of the default. Not a secret. |
| `CUMULUS_COGNITO_REGION` | plain | Region for that pool. Unset, it is the prefix of the pool id. |
| `CUMULUS_OIDC_JWKS_URL` | plain | Overrides the JWKS URL. Unset, Mail reads `jwks_uri` from the issuer's discovery document and falls back to `<issuer>/.well-known/jwks.json` (`/protocol/openid-connect/certs` for a Keycloak realm). |
| `GROK_AUTH_ISSUER` | plain | Better Auth broker issuer. Required only when the app session uses that broker. |
| `GROK_AUTH_CLIENT_ID` | plain | Broker client id. Not a secret. Required only for that broker. |
| `GROK_AUTH_CLIENT_SECRET` | secret | Broker client secret. Required only for that broker. |

### Optional

| Name | Kind | Role |
| --- | --- | --- |
| `MAIL_AUTH_DNS` | plain | Set to `live` only after SPF, DKIM, and DMARC are published. Unset means the inbound check does not query DNS. Leave it unset for the smoke test. |
| `XAI_API_KEY` | secret | Optional. SCALVS drafts. Mail works without it. |
| `VITE_STUN_URLS` | plain | Optional WebRTC STUN list. Not used by mail storage. |
| `MAIL_BLOB_DIR` | plain | Local disk directory. Ignore it when `MAIL_STORAGE=s3`. |
| `MAIL_S3_LOOPBACK_ONLY` | plain | Must be unset or not `1`. `1` refuses the Supabase host. |

### Not production settings

| Name | Kind | Role |
| --- | --- | --- |
| `MAIL_RUNTIME_DATABASE_URL` | plain | CI and the runtime test only. The app does not read it. Do not set it on the Worker. |
| `GROK_PROJECT_ID` | plain | Preview and gate identity. Not required for this mailbox. |
| `GROK_GATE_ORIGIN` | plain | Preview gate. Not required for this mailbox. |
| `GROK_CONNECTORS_URL` | plain | Preview connectors. Not required for this mailbox. |
| `GROK_CONNECTOR_ACCESS_TOKEN` | secret | Preview connectors. Do not copy a preview token into this deploy. |

The inbound template's `[vars]` are only `MAIL_DOMAIN` and `MAIL_APP_HOST`. Add `MAIL_AUTH_DNS` there only when you are ready for live DNS. Do not put `MAIL_BLOB_KEY`, `DATABASE_URL`, or the Storage secret in the template file.

## 5. Smoke test, before any MX

Do this after the API Worker, the static UI, Hyperdrive, and the private Storage bucket exist, and before Email Routing is attached. Do not add an MX record. Do not apply `docs/dns/spf-dkim-dmarc.template.txt`. Do not set `MAIL_AUTH_DNS`.

`node scripts/smoke.mjs` reads environment variables only. With the storage, database, and issuer variables unset, it prints three skip lines and exits 0. It does not contact Supabase or the identity host. CI runs it that way. When those variables are set, the same script writes and deletes one probe object, checks that the other tenant cannot read it, checks the database connection and that the four approved migrations are present, and fetches OIDC discovery. A configured storage run needs `node --experimental-strip-types scripts/smoke.mjs`. Do not point it at a project that has not been approved. This handoff does not run it against a live project.

Use the mailbox address `smoke@cumuluscloud.app`. It is only an address inside the app. The public internet cannot deliver to it until MX exists, which is the point of this test.

1. From a checkout of the head commit, run `node scripts/smoke.mjs` with no Supabase variables and confirm the three skip lines. After the migrations are approved and the bucket exists, export `DATABASE_URL`, `CUMULUS_ALLOW_SUPABASE=1`, `CUMULUS_OIDC_ISSUER`, and the Storage variables, then run `node --experimental-strip-types scripts/smoke.mjs`. Do not run `npm run db:migrate` until section 3 is approved.
2. Open the UI on the Pages or Workers Assets URL. Sign in. Confirm the mailbox loads and that sending is not required to load it.
3. Provision `smoke@cumuluscloud.app` by opening that mailbox once through the API (the first read creates it). If the signed-in user is a different address, use that address in step 4 instead, and still do not publish MX.
4. Inject one message by calling the same `handleEmail` function the Worker exports. Run this from the checkout, with the same environment, and with no `MAIL_AUTH_DNS`:

```sh
node --experimental-strip-types --input-type=module <<'EOF'
import { handleEmail } from "./workers/email/src/index.ts";
import { getSql } from "./src/lib/db.ts";
import { createStorageDriver, openTenantStorage } from "./src/lib/storage/index.ts";
import { readSnapshot } from "./src/lib/mail/records.ts";
import { findTenantByAddress } from "./src/lib/mail/directory.ts";

const to = process.env.SMOKE_ADDRESS || "smoke@cumuluscloud.app";
const raw = [
  "From: Smoke <smoke-sender@example.test>",
  `To: <${to}>`,
  "Subject: Smoke test",
  "Message-ID: <smoke-handoff@example.test>",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Stored without MX.",
  "",
].join("\r\n");

const sql = await getSql();
const db = { query: (text, params) => sql.query(text, params ?? []) };
const driver = createStorageDriver();
const storageFor = (tenantId) => openTenantStorage(tenantId, driver);
const stored = await handleEmail(
  { from: "smoke-sender@example.test", to, raw: new TextEncoder().encode(raw) },
  { ingest: { db, storageFor }, MAIL_DOMAIN: "cumuluscloud.app" },
);
if (stored.stored.length !== 1) throw new Error("Inbound handler did not store the message");
const tenantId = await findTenantByAddress(db, to);
const box = await readSnapshot(db, tenantId);
const message = box.messages.find((item) => item.subject === "Smoke test");
if (!message || message.folder !== "inbox") throw new Error("Message was not in the inbox");
console.log("stored", message.id, "tenant", tenantId);
EOF
```

5. Reload the UI for that mailbox. The inbox must show **Smoke test** and the body `Stored without MX.` A second signed-in mailbox must not show it.
6. In the Supabase bucket, confirm the new object key is `tenants/<tenantId>/<32 hex chars>` and that the object body is not the plaintext sentence.
7. In Postgres, confirm `cumulus_mail.messages.subject` for that row does not contain `Smoke test`.
8. Compose from the UI to `outside@example.test`. It must remain in the outbox. The hop detail must be `Held in the outbox. This preview does not send outside Cumulus.` Nothing is transmitted. The inbound worker still has no send binding.
9. Only after steps 1 through 8 pass, and only as a separate decision, add MX and the records in `docs/dns/spf-dkim-dmarc.template.txt`, then set `MAIL_AUTH_DNS=live` and attach Email Routing to `cumulus-mail-inbound`. This document does not perform that step.

## 6. Outbound mail

Outbound mail stays held and disabled.

- Mail to a non-Cumulus address is stored on the sender's mailbox with status `outbound` and the detail in step 8. It is not sent.
- The inbound worker template has no send binding and must not gain one.
- Do not add an Email Routing destination that forwards or sends.
- Do not set MX in order to finish this handoff. MX is allowed only after the smoke test has verified the API, the UI, Postgres, and Supabase Storage.
