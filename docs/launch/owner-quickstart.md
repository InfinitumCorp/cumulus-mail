# Owner quickstart: Friday on one page

The full sequence, with every check and rollback, is `friday.md`; incidents are `docs/ops/incident.md`.
This page holds **names only**: no value of any secret belongs in this repository.

## 1. Merge order (before go/no-go)
Already on `main`: everything up to #217 (main fc7c058), including #214's transactions fix (through #217) and migration 0024 (#213). Production still serves the old page (checked 27 Nov).
Still open, merge in this order, waiting for CI after each:

1. **#219**: outbound SMTP from the API worker over `cloudflare:sockets`.
2. The PR that updates these pages.

**Before go:** Hyperdrive query caching off: `npx wrangler hyperdrive update d07a82ac7fcc42ac84dc6469140ef551 --caching-disabled` (see `friday.md`, go/no-go).

Then write down the `main` commit you will deploy. Every command below runs from a checkout of it.

## 2. What to set where (names only)
| Where | Names |
|---|---|
| GitHub environment `production-us` (secrets) | `MAIL_BLOB_KEY`, `MAIL_BLIND_KEY` (same value as `MAIL_BLOB_KEY`), `SUPABASE_S3_ACCESS_KEY_ID`, `SUPABASE_S3_SECRET_ACCESS_KEY`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `HYPERDRIVE_ID`; `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` only if billing goes live |
| Worker `cumulus-mail-inbound` (`npx wrangler secret put`, from `workers/email`) | `MAIL_BLOB_KEY`, `MAIL_BLIND_KEY`, `SUPABASE_S3_ACCESS_KEY_ID`, `SUPABASE_S3_SECRET_ACCESS_KEY` |
| GitHub environment `production-ru` | secret `YC_SA_KEY_JSON`; variables `YC_CLOUD_ID`, `YC_FOLDER_ID`, `YC_REGISTRY_ID`, `YC_SA_ID`, `YC_LOCKBOX_ID` |
| Yandex Lockbox (RU) | `BETTER_AUTH_SECRET`, `DATABASE_URL`, `MAIL_BLOB_KEY`, `MAIL_BLIND_KEY`, `MAIL_S3_ACCESS_KEY_ID`, `MAIL_S3_SECRET_ACCESS_KEY`, `CRON_SECRET` (32+ characters) |
| Worker variables, set in the Cloudflare dashboard (they survive deploys: `keep_vars`) | `MAIL_AUTH_DNS=live` (inbound worker, step 7); `MAIL_MAINTENANCE=1` only for a maintenance window (API worker) |
| Later in the day | `MAIL_SMTP_HOST`, `MAIL_SMTP_PORT`, `MAIL_SMTP_USER`, `MAIL_SMTP_PASSWORD`, `MAIL_DKIM_SELECTOR`, `MAIL_DKIM_PRIVATE_KEY` (step 10); `BETTER_AUTH_TRUSTED_PROXIES` only if RU's `x-forwarded-for` is a chain (step 9) |

New keys: `openssl rand -hex 32`, each saved in your password manager **before** it goes into a platform.
The RU keys differ from the US keys.

## 3. The commands, in order
Run each in a shell with that region's settings and `DATABASE_URL` exported.

```sh
npm ci
npm run cutover:check -- --region us --selector <dkim selector>   # go/no-go, once the secrets exist; read-only
npm run cutover:check -- --region ru --no-dns
npm run db:status        # US, then RU: 0001_auth, then 0011 up to the newest file (a new RU database: all), exit 3
npm run db:migrate       # applies them, in that order
npm run db:status        # up to date, exit 0
npm run cutover:check -- --region us                    # now: "ok anon is refused on public.session"
# GitHub Actions → Deploy US (Cloudflare), target both, confirm "deploy us"
npm run smoke -- --url https://cumulus-mail-api.<account>.workers.dev --region us
# cutover.md Phases 1–2: Email Routing catch-all, then the mail.cumuluscloud.app domain; BETTER_AUTH_URL; redeploy api
npm run smoke -- --url https://mail.cumuluscloud.app --domain cumuluscloud.app
# DNS: SPF, DKIM, DMARC (dns-records.md), then:
npm run preflight -- --region us --selector <dkim selector>   # then MAIL_AUTH_DNS=live
# GitHub Actions → Deploy RU (Yandex Cloud), confirm "deploy ru"
npm run smoke -- --url https://<id>.apigw.yandexcloud.net --region ru
# cutover.md Phase 3: ru.mail DNS-only to the gateway; timer trigger POST /api/cron/tick with the CRON_SECRET
npm run smoke -- --url https://ru.mail.cumuluscloud.app
```

## 4. Go / no-go
**Go** only if all of these hold:
- `main` is green in CI on the commit you deploy.
- `cutover:check` shows nothing MISSING for either region except the DNS lines steps 6–7 add. The expected
  WARNs are listed in `friday.md`.
- After `db:migrate`: `db:status` exits 0 and `anon is refused on public.session` is ok.
- `smoke` on the workers.dev URL is all ok, and one real sign-in works there.

**No-go** at any failed check before step 6: stop. Users have seen nothing.

## 5. Rollback
- **A bad deploy:** US: Cloudflare → Workers → `cumulus-mail-api` / `cumulus-mail-inbound` → Deployments →
  previous version → Rollback. RU: Yandex → Serverless Containers → Revisions → make the previous one
  active. Check: `/api/health` shows the previous `commit`, and `npm run smoke -- --url <host>` is all ok.
- **The cutover:** move the custom domain and the Email Routing catch-all back to `cumulus-mail`, and set
  `BETTER_AUTH_URL` back to the workers.dev origin (`friday.md` step 6).
- **Spam going out:** `npm run outbound:pause -- --address <mailbox> --hours 72`, or unset `MAIL_SMTP_HOST`
  for everyone.
- **Everything else:** `docs/ops/incident.md`. Migrations need no rollback; they are additive.
