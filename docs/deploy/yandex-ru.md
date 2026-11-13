# Russia copy on Yandex Cloud (ru.mail.cumuluscloud.app)

Global users are served from Cloudflare's US region (Ashburn, Virginia; `docs/deploy/cloudflare-handoff.md`).
People in Russia are served by a separate copy on **Yandex Cloud, region `ru-central1`**, reachable without
a VPN and not behind Cloudflare. This page is the runbook for that copy. Nothing here is run by the repository,
and no secret is in it.

The copy is the same code as `main`, built as a plain Node server (`npm run build:node`, Nitro preset
`node-server`) and shipped as a container image (`Dockerfile`).

## Decisions for the owner (not made here)

| # | Decision | Options | Notes |
|---|---|---|---|
| D1 | **Where Russian users' mail and account data live** | (a) Yandex Managed PostgreSQL in `ru-central1`, separate from the US database; (b) the shared Supabase database (`eu-west-1`) | Russian law (152-FZ) requires personal data of Russian citizens to be first recorded and stored in databases located in Russia. (a) keeps it in Russia; (b) does not. Get legal sign-off. |
| D2 | **Where blobs (message bodies, attachments) live** | (a) Yandex Object Storage bucket in `ru-central1`; (b) the shared Supabase Storage bucket | Same consideration as D1. Blobs are sealed with `MAIL_BLOB_KEY` before upload either way. |
| D3 | **Inbound mail for Russian mailboxes** | Inbound for `@cumuluscloud.app` arrives through Cloudflare Email Routing (US worker `cumulus-mail-inbound`), which writes to the database it is bound to | With D1 (a), the US worker cannot deliver into the Russian database. Options: a separate mail domain or subdomain for Russian mailboxes with its own MX in Russia; or have the US worker hand Russian recipients to the RU copy. Needs a design decision before Russian mailboxes receive mail. |
| D4 | **Scheduled jobs** (scheduled send, outbound queue) | A Yandex Cloud timer trigger, or a cron on a VM, calling `POST /api/cron/tick` every minute with `Authorization: Bearer <CRON_SECRET>` (#88) | In the US these run from the inbound worker's cron. The endpoint is off (404) until `CRON_SECRET` is set; put it in Lockbox. |
| D5 | **Serverless Container vs VM** | Serverless Container + API Gateway (default here); or one Compute VM with `deploy/yandex/docker-compose.yml` behind an ALB | Serverless scales to zero; a VM keeps PGLite-free warm state and simpler networking. |
| D6 | **Cumulus ID mirror** | `CID_ISSUER=https://ru.id.cumuluscloud.app` (assumed) | Confirm the mirror host and that nexus lists `https://ru.mail.cumuluscloud.app` for the `cumulus-mail` client. |

## What the owner must supply

| Item | Where it goes |
|---|---|
| Yandex Cloud: cloud + folder, `yc` logged in | your machine or CI |
| Container Registry id | `REGISTRY_ID` for `deploy/yandex/deploy.sh` |
| Service account with `container-registry.images.puller`, `lockbox.payloadViewer`, (and `storage.editor` on the bucket for its static key) | `SA_ID` |
| Lockbox secret with keys `BETTER_AUTH_SECRET`, `DATABASE_URL`, `MAIL_BLOB_KEY`, `MAIL_S3_ACCESS_KEY_ID`, `MAIL_S3_SECRET_ACCESS_KEY`, `CRON_SECRET` | `LOCKBOX_ID` |
| TLS certificate for `ru.mail.cumuluscloud.app` (Certificate Manager) | API Gateway / ALB |
| DNS record for `ru.mail.cumuluscloud.app` → the gateway | DNS (owner only) |

`BETTER_AUTH_SECRET` is mandatory: with a database configured and no secret, sign-in refuses to start
(`MissingAuthSecretError`) rather than signing sessions with a random key.

## Steps

1. **Database (D1).** Create the database (Managed PostgreSQL 16+ in `ru-central1`, or use the shared one).
   Apply the migrations in `migrations/` in file-name order, recording each file name in
   `public._migrations (name text primary key, applied_at timestamptz default now())`, the same table the app
   and the US database use. From a checkout of the commit being deployed:
   `DATABASE_URL=… npm run db:status` lists what is pending (exit 3) without changing anything, and
   `DATABASE_URL=… npm run db:migrate` applies it, one transaction per file. Run `db:status` again before
   every deploy: with #91, `/api/health` reports `schema.pending` and is `degraded` until it is 0. Put the connection string (with `sslmode=verify-full` and Yandex's CA, or
   `sslmode=require`) in Lockbox as `DATABASE_URL`.
2. **Object Storage (D2).** Create the bucket `cumulus-mail-ru` (private, no public access) and a static
   access key for the service account. Put the key pair in Lockbox. The app uses the generic S3 driver with
   `MAIL_S3_ENDPOINT=https://storage.yandexcloud.net`, `MAIL_S3_REGION=ru-central1`, path-style requests.
3. **Secrets.** Add `BETTER_AUTH_SECRET` (random, 32+ bytes) and `MAIL_BLOB_KEY` (32 random bytes) to the
   same Lockbox secret. Never reuse a local key.
4. **Settings.** Review `deploy/yandex/ru.env.example`. Its plain `KEY=VALUE` lines are passed to the
   container as environment variables by the deploy script. Optional features (Stripe, outbound SMTP,
   `MAIL_DEFAULT_PLAN`) stay off unless their settings are added.
5. **Build, push, deploy.** From a checkout of `main`:

   ```sh
   REGISTRY_ID=crp... SA_ID=aje... LOCKBOX_ID=e6q... ./deploy/yandex/deploy.sh
   ```

   The script prints the folder and image and asks before doing anything. It builds the image, pushes it
   to `cr.yandex/<registry>/cumulus-mail-ru:<commit>`, creates the Serverless Container if needed, and
   deploys a revision with the plain settings and the Lockbox secrets.
   Or run it from GitHub: **Actions → Deploy RU (Yandex Cloud) → Run workflow** on `main`, typing
   `deploy ru`. It runs in the `production-ru` environment (add required reviewers there), whose secret
   `YC_SA_KEY_JSON` (deploy service account key) and variables `YC_CLOUD_ID`, `YC_FOLDER_ID`,
   `YC_REGISTRY_ID`, `YC_SA_ID`, `YC_LOCKBOX_ID` the owner sets. App secrets stay in Lockbox.
6. **Custom domain.** Create an API Gateway with an `x-yc-apigateway-integration` of type
   `serverless_containers` for `/{proxy+}` (all methods) pointing at the container, attach the
   `ru.mail.cumuluscloud.app` certificate as the gateway's domain, then point DNS at it (owner).
   The gateway sets `X-Forwarded-For`, which Better Auth uses for rate limiting.
7. **Check.** `GET https://ru.mail.cumuluscloud.app/api/auth/get-session` answers `200`; the page shows
   "Sign in with Cumulus ID"; signing in round-trips through the mirror (D6).

## Guardrails

- Do not point `ru.mail.cumuluscloud.app` (or anything) at Cloudflare for this copy: it must load in Russia
  without a VPN.
- The US guardrails still hold: never deploy over the Cloudflare worker `cumulus-mail`, do not take the
  Email Routing catch-all before the handoff's section 6 test, no R2.
- No secret in the image, `ru.env.example`, the deploy script or git. The image reads everything from its
  environment at run time.

## Local smoke test of the image

```sh
docker build -t cumulus-mail-ru:test .
docker run --rm -p 8080:8080 -e MAIL_BLOB_KEY=$(openssl rand -hex 32) cumulus-mail-ru:test
# http://localhost:8080 shows "Sign in with Cumulus ID"; GET /api/auth/get-session -> 200 null
```

Without `DATABASE_URL` the container uses the in-process PGLite database (nothing persists). With
`DATABASE_URL` set and no `BETTER_AUTH_SECRET`, sign-in refuses to start, as in production.
