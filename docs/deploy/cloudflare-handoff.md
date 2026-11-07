# Cloudflare handoff for Cumulus://Mail

This file is for the operator who deploys. It does not deploy anything, and it does not change DNS or MX.

Outbound mail stays held. The inbound worker has no send binding. Do not add one.

## 1. Head commit

Deploy the head of branch `cursor/mail-inbound-runtime-5933` (pull request 6).

The application code is commit `fb47aeb1b574803b11f69f72593cb6c0b3e7c5f2`. This document is the only change after that commit. After you fetch the branch, the exact head is:

```sh
git rev-parse HEAD
git merge-base --is-ancestor fb47aeb1b574803b11f69f72593cb6c0b3e7c5f2 HEAD
```

The ancestor check must succeed. Do not deploy `main` or an older preview commit. Do not deploy from a tree that has uncommitted edits.

## 2. What runs where

Three pieces. They are not one Wrangler project today.

### API

The mailbox API is the TanStack Start server functions in `src/lib/mail/api.ts`: read and write the mailbox, read an attachment, export and import, abuse intake, delivery-status intake, and share links. The tenant comes from the verified session or from a verified Cumulus token (`tenant_id`). It is never taken from the request body.

`vite.config.ts` builds that server with Nitro preset `vercel`. That preset does not produce a Cloudflare Worker. For Workers, change the Nitro preset to `cloudflare-module` and deploy that output as the API Worker. Leave the preset change and the deploy to the operator. This handoff does not make that change.

The API reads Postgres through `DATABASE_URL` (`src/lib/db.ts`, package `pg`). On Workers, `pg` cannot open a raw socket to Postgres. Put Hyperdrive in front of the Postgres database and set `DATABASE_URL` to the Hyperdrive connection string before the app reads it. Hyperdrive is the adapter that matches this code.

D1 is not a substitute. The schema is Postgres (`cumulus_mail`, migrations `0002` through `0005`, including `create schema` and `timestamptz`). Those files do not run on D1 without a port that this tree does not contain.

Apply the migrations with `npm run db:migrate` from a machine that can reach the database. With `DATABASE_URL` unset, that command skips. The embedded PGLite database is only the local fallback. Do not use it for this deploy.

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

`email()` stores a message only when `env.ingest` is set to `{ db, storageFor }` using the same query and storage interface as the API. If `ingest` is missing, the handler throws and stores nothing. The template does not declare that binding. Wire Postgres (through Hyperdrive) and R2 into `ingest` before any mail is attached to the worker. Do not declare an MX or an Email Routing route until the smoke test below has passed.

The handler accepts a recipient only when the address ends with `MAIL_DOMAIN` (default `cumuluscloud.app`). SPF, DKIM, and DMARC run only when `MAIL_AUTH_DNS=live`. Leave that unset for the smoke test so the worker does not query DNS.

### Static UI

The browser UI is the Vite client. It loads the mailbox by calling the API (`getMailbox` and `getAttachment`). Put the built static files on Cloudflare Pages or on Workers Assets. Point them at the API Worker. A Pages or Workers Assets host by itself has no mailbox.

The web host the app expects is `mail.cumuluscloud.app` (`MAIL_APP_HOST` / `VITE_MAIL_APP_HOST`). A `pages.dev` or workers hostname is enough for the smoke test. Do not add MX to make the UI load.

## 3. R2 storage

Blob bytes use the S3 driver (`MAIL_STORAGE=s3`), which is AWS SDK v3 with path-style keys and checksums set to `WHEN_REQUIRED`. R2 is that driver pointed at Cloudflare's S3 endpoint.

Create one R2 bucket. Set `MAIL_S3_BUCKET` to its name. If `MAIL_S3_BUCKET` is unset, the code uses `cumulus-mail-preview`. Create the bucket yourself. The app's `ensureBucket()` will create a missing bucket only when the credentials allow it. Prefer creating `cumulus-mail` and setting `MAIL_S3_BUCKET` to that name.

Object key, for every attachment and every raw MIME blob:

```text
tenants/<tenantId>/<blobId>
```

`tenantId` matches `[A-Za-z0-9_-]{1,80}`. `blobId` is 32 lowercase hex characters. The bytes on R2 are AES-256-GCM ciphertext. The plaintext SHA-256 stays in Postgres. Do not turn on `MAIL_S3_LOOPBACK_ONLY` for R2. That flag allows only `127.0.0.1`, `localhost`, and `[::1]`.

S3 settings for R2:

| Setting | Value |
| --- | --- |
| `MAIL_S3_ENDPOINT` | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |
| `MAIL_S3_REGION` | `auto` |
| `MAIL_S3_BUCKET` | the bucket name you created |
| Path style | already forced by the driver |
| Checksums | already `WHEN_REQUIRED` |
| Access key | an R2 S3 token with object read and write on that bucket |

`<ACCOUNT_ID>` is the Cloudflare account id. Do not point this endpoint at `*.supabase.co`. The driver refuses that host unless `CUMULUS_ALLOW_SUPABASE=1`, which this deploy must not set.

The same key layout and the same driver are what the API and `env.ingest.storageFor` must use. A blob written by the inbound handler is read by the API.

## 4. Environment variables

No values belong in this file. Mark secret names as secrets in the Worker and in Pages. Plain names can be `[vars]`.

### Required for the API and for ingest

| Name | Kind | Role |
| --- | --- | --- |
| `DATABASE_URL` | secret | Postgres via Hyperdrive. Required. Auth refuses to start against a real database when sign-in is off. |
| `MAIL_BLOB_KEY` | secret | 32 bytes, hex (64 chars) or base64. Per-tenant AES-256-GCM for blobs, subjects, addresses, snippets, headers, display names, signatures, and authentication results. |
| `MAIL_STORAGE` | plain | `s3` for R2. Unset means local disk, which Workers do not have. |
| `MAIL_S3_BUCKET` | plain | R2 bucket name. |
| `MAIL_S3_ENDPOINT` | plain | R2 S3 endpoint. The account id inside it is not a key, but treat the URL as account configuration. |
| `MAIL_S3_REGION` | plain | `auto` for R2. Unset selects `us-east-1`, which is the wrong region for R2. |
| `MAIL_S3_ACCESS_KEY_ID` | secret | R2 S3 access key id. |
| `MAIL_S3_SECRET_ACCESS_KEY` | secret | R2 S3 secret. |
| `MAIL_DOMAIN` | plain | `cumuluscloud.app`. Also a `[vars]` entry on the inbound worker. |
| `MAIL_APP_HOST` | plain | `mail.cumuluscloud.app`. Also a `[vars]` entry on the inbound worker. |
| `VITE_MAIL_DOMAIN` | plain | Same domain, baked into the browser build. |
| `VITE_MAIL_APP_HOST` | plain | Same host, baked into the browser build. |
| `VITE_AUTH_ENABLED` | plain | `true` for this deploy. `false` with `DATABASE_URL` set fails closed. |
| `BETTER_AUTH_SECRET` | secret | Session signing secret. |
| `BETTER_AUTH_URL` | plain | Public origin of the API, `https://mail.cumuluscloud.app` once that host exists. |
| `CUMULUS_OIDC_ISSUER` | plain | Defaults to `https://id.cumuluscloud.app/realms/cumulus`. A bearer whose issuer is this realm is verified there, and the tenant is the verified `tenant_id` claim. |
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
| `MAIL_S3_LOOPBACK_ONLY` | plain | Must be unset or not `1` for R2. |
| `CUMULUS_ALLOW_SUPABASE` | plain | Must be unset. `1` would allow a Supabase S3 host. Do not set it. |

### Not production settings

| Name | Kind | Role |
| --- | --- | --- |
| `MAIL_RUNTIME_DATABASE_URL` | plain | CI and the runtime test only. The app does not read it. Do not set it on the Worker. |
| `GROK_PROJECT_ID` | plain | Preview and gate identity. Not required for this mailbox. |
| `GROK_GATE_ORIGIN` | plain | Preview gate. Not required for this mailbox. |
| `GROK_CONNECTORS_URL` | plain | Preview connectors. Not required for this mailbox. |
| `GROK_CONNECTOR_ACCESS_TOKEN` | secret | Preview connectors. Do not copy a preview token into this deploy. |

The inbound template's `[vars]` are only `MAIL_DOMAIN` and `MAIL_APP_HOST`. Add `MAIL_AUTH_DNS` there only when you are ready for live DNS. Do not put `MAIL_BLOB_KEY`, `DATABASE_URL`, or the R2 secret in the template file.

## 5. Smoke test, before any MX

Do this after the API Worker, the static UI, Hyperdrive, and R2 are up, and before Email Routing is attached. Do not add an MX record. Do not apply `docs/dns/spf-dkim-dmarc.template.txt`. Do not set `MAIL_AUTH_DNS`.

Use the mailbox address `smoke@cumuluscloud.app`. It is only an address inside the app. The public internet cannot deliver to it until MX exists, which is the point of this test.

1. From a checkout of the head commit, with `DATABASE_URL`, `MAIL_BLOB_KEY`, and the R2 variables exported in the shell and `MAIL_STORAGE=s3`, run `npm run db:migrate`. It must apply `migrations/0002_cumulus_mail.sql` through `migrations/0005_profile_and_routes.sql`.
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
6. In R2, confirm the new object key is `tenants/<tenantId>/<32 hex chars>` and that the object body is not the plaintext sentence.
7. In Postgres, confirm `cumulus_mail.messages.subject` for that row does not contain `Smoke test`.
8. Compose from the UI to `outside@example.test`. It must remain in the outbox. The hop detail must be `Held in the outbox. This preview does not send outside Cumulus.` Nothing is transmitted. The inbound worker still has no send binding.
9. Only after steps 1 through 8 pass, and only as a separate decision, add MX and the records in `docs/dns/spf-dkim-dmarc.template.txt`, then set `MAIL_AUTH_DNS=live` and attach Email Routing to `cumulus-mail-inbound`. This document does not perform that step.

## 6. Outbound mail

Outbound mail stays held and disabled.

- Mail to a non-Cumulus address is stored on the sender's mailbox with status `outbound` and the detail in step 8. It is not sent.
- The inbound worker template has no send binding and must not gain one.
- Do not add an Email Routing destination that forwards or sends.
- Do not set MX in order to "finish" this handoff. MX is allowed only after the smoke test has verified the API, the UI, Postgres, and R2.
