# Launch checklist (owner actions)

Production runs on **our own servers**, in two regions, and **not on Vercel**:

| Region | Who | Where | Runbook |
|---|---|---|---|
| **US** (everyone outside Russia) | `mail.cumuluscloud.app` | Cloudflare Workers, US placement (Ashburn, Virginia) | `docs/deploy/cloudflare-handoff.md` |
| **RU** (people in Russia) | `ru.mail.cumuluscloud.app` | Yandex Cloud, `ru-central1`, not behind Cloudflare | `docs/deploy/yandex-ru.md` |

Everything below is something only the owner can do: keys, accounts, DNS and decisions. Nothing is on until it
is set. Secrets go in the platform's secret store (Cloudflare: `wrangler secret put`; Yandex: Lockbox), never in
this repository.

## 0. Already done

- [x] Sign-in decision: **keep Cumulus ID** (#70 merged). Google-only sign-in (#63, #67) is not shipped.
- [x] Production database (Supabase `ivqiskeziohbbtkcvlun`): migrations `0006`–`0010` applied and recorded in
      `public._migrations` (2026-11-12). The mail tables were empty.
- [ ] Vercel auto-deploy off: merge #75 (`git.deploymentEnabled: false`).

## 1. Both regions

- [ ] `BETTER_AUTH_SECRET`: random, 32+ bytes, in each region's secret store. **Sign-in refuses to start
      without it** on a deployment (never falls back to a random secret).
- [ ] Cumulus ID (nexus) lists both origins for the public client `cumulus-mail`: `https://mail.cumuluscloud.app`
      and `https://ru.mail.cumuluscloud.app`. `CID_ISSUER` / `CID_CLIENT_ID` only to override (RU uses the mirror).
- [ ] `MAIL_BLOB_KEY` (32 random bytes) per region; never reuse a local key. A region that shares a bucket with
      another must share its key.

## 2. US: Cloudflare Workers (`docs/deploy/cloudflare-handoff.md`)

Guardrails from the handoff, unchanged: **never deploy over the existing worker `cumulus-mail`**; the API
worker is `cumulus-mail-api` on workers.dev with **no routes and no custom domain**; **do not take the Email
Routing catch-all** from `cumulus-mail` until the handoff's section 6 test has passed; **no R2**, no
`send_email` binding; no MX or DNS change as part of the deploy.

- [ ] Cloudflare API token (Workers Scripts edit, Hyperdrive read) and account id - for whoever runs the deploy.
- [ ] Hyperdrive config for the production database; paste its id over `REPLACE_WITH_HYPERDRIVE_ID` in
      `workers/email/wrangler.jsonc` (and `workers/api/wrangler.jsonc` if the API worker is deployed).
- [ ] Inbound worker secrets: `MAIL_BLOB_KEY`, `SUPABASE_S3_ACCESS_KEY_ID`, `SUPABASE_S3_SECRET_ACCESS_KEY`;
      API worker also `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (its workers.dev origin).
- [ ] `npx wrangler whoami` is the account that owns `cumulus-mail`; then deploy `cumulus-mail-inbound`
      (`workers/email`), run the real-database probe, and only then switch the catch-all (handoff section 7).
- [ ] Settings reach the API worker by prefix (`MAIL_`, `STRIPE_`, `BILLING_`, `CID_`, `CUMULUS_`, ...; #72).

## 3. RU: Yandex Cloud (`docs/deploy/yandex-ru.md`, PR #76)

- [ ] **Decisions first** (in the runbook): where Russian users' data and blobs live (152-FZ: Managed
      PostgreSQL + Object Storage in `ru-central1`, or the shared Supabase project in `eu-west-1`); how inbound
      mail reaches Russian mailboxes; a scheduler for scheduled send / outbound queue; Serverless Container or VM.
- [ ] Yandex Cloud folder, Container Registry, a service account (image pull, Lockbox read, bucket access).
- [ ] Lockbox secret with `BETTER_AUTH_SECRET`, `DATABASE_URL`, `MAIL_BLOB_KEY`, `MAIL_S3_ACCESS_KEY_ID`,
      `MAIL_S3_SECRET_ACCESS_KEY`.
- [ ] If RU gets its own database: apply `migrations/0001`–`0010` there, recorded in `public._migrations`.
- [ ] `REGISTRY_ID=… SA_ID=… LOCKBOX_ID=… ./deploy/yandex/deploy.sh` (asks before acting).
- [ ] API Gateway (or ALB) with the `ru.mail.cumuluscloud.app` certificate; DNS for it (owner). Keep it off
      Cloudflare so it loads in Russia without a VPN.
- [ ] Check: `GET /api/auth/get-session` → 200, "Sign in with Cumulus ID" shows, sign-in round-trips the mirror.

## 4. Billing: Stripe (PR #64, test mode first)

- [ ] Set the prices (docs/plans.md §2 still says "owner to set").
- [ ] Products **Plus**, **Pro**, **Business**, each with a monthly and yearly price, lookup keys
      `plus_monthly`, `plus_yearly`, `pro_monthly`, `pro_yearly`, `business_monthly`, `business_yearly`.
- [ ] Turn on the Customer Portal (plan changes, card updates, cancel, invoices).
- [ ] Webhook endpoint `<app origin>/api/billing/webhook` for `checkout.session.completed`,
      `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`,
      `invoice.payment_failed`.
- [ ] Secrets: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`. Optional `BILLING_RETURN_URL`.
- [ ] Test-mode run: upgrade with card `4242 4242 4242 4242`, check the plan changes in the account dialog;
      use `4000 0000 0000 0341` to see the "Payment failed" notice; cancel in the Portal and see Free limits.
- [ ] Switch to live keys only after that.

## 5. Plans and limits (PR #59, #65, #66, #68)

- [ ] **Grandfathering decision** (docs/plans.md §6): keep existing mailboxes on Plus for free, or tell them
      ahead and move them to Free. Existing mailboxes are on Plus today and nothing moves them.
- [ ] `MAIL_DEFAULT_PLAN=free` when new sign-ups should start on Free. Unset keeps Plus.
- [ ] `MAIL_ENFORCE_STORAGE=1` on the inbound worker (US) / the RU container when full mailboxes should bounce new mail
      (`552 5.2.2 Mailbox full`). Unset accepts mail as before. The sidebar already warns at 90% and 100%.

## 6. Outbound mail to the internet (PR #40, #47, #56, #57, #61, #45, #49)

Setup details: `docs/deploy/outbound-smtp.md`.

- [ ] An SMTP relay account. Secrets/vars: `MAIL_SMTP_HOST`, `MAIL_SMTP_PORT`, `MAIL_SMTP_SECURITY`,
      `MAIL_SMTP_USER`, `MAIL_SMTP_PASSWORD` (secret).
- [ ] DKIM key pair; publish the public key as `<selector>._domainkey.<MAIL_DOMAIN>` (DNS change, owner only);
      set `MAIL_DKIM_SELECTOR` and `MAIL_DKIM_PRIVATE_KEY` (secret) or `MAIL_DKIM_KEY_PATH`.
- [ ] SPF and DMARC records that include the relay (templates in `docs/dns/`).
- [ ] Optional rate limits: `MAIL_OUTBOUND_HOURLY_LIMIT` (default 100), `MAIL_OUTBOUND_DAILY_LIMIT` (default 500).

Without `MAIL_SMTP_HOST`, outside mail stays held in the Outbox as it does today.

## 7. Before turning things on

- [ ] `npm run test:e2e` on `main` (browser smoke tests, local mode); CI runs it and the Docker image check.
- [ ] `node scripts/smoke.mjs` against each region's real database and storage.
