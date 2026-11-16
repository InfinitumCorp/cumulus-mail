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
- [ ] Production database: apply the migrations on `main` that it does not have yet, **before** deploying code that
      uses them: `0011_message_words.sql` (server-side search, #84), `0016_calendar_feeds.sql` (#108),
      `0017_outbound_safety.sql` (#126). `npm run db:status` lists what is pending and exits 3 if anything is.
      `0012`–`0015` arrive with #96, #100, #101 and #106. Files apply by name, so applying them after `0016`/`0017`
      is fine; each is recorded in `public._migrations`.

## 1. Both regions

- [ ] `BETTER_AUTH_SECRET`: random, 32+ bytes, in each region's secret store. **Sign-in refuses to start
      without it** on a deployment (never falls back to a random secret).
- [ ] Cumulus ID (nexus) lists both origins for the public client `cumulus-mail`: `https://mail.cumuluscloud.app`
      and `https://ru.mail.cumuluscloud.app`. `CID_ISSUER` / `CID_CLIENT_ID` only to override (RU uses the mirror).
- [ ] `MAIL_BLOB_KEY` (32 random bytes) per region; never reuse a local key. A region that shares a bucket with
      another must share its key.
- [ ] `MAIL_BLIND_KEY`: set it to the **same value** as `MAIL_BLOB_KEY` at launch. Search and lookup indexes are
      keyed by it, so `MAIL_BLOB_KEY` can later be rotated with `MAIL_BLOB_KEYS` (`docs/ops/key-rotation.md`, #114)
      without rebuilding them.
- [ ] **Back up every key** (`MAIL_BLOB_KEY`, `MAIL_BLIND_KEY`, every key ever listed in `MAIL_BLOB_KEYS`) outside
      the platform's secret store. A database dump and a blob copy are useless without them: `npm run
      drill:restore` (#123, runbook §9) proves that mail sealed under a key does not open without it.
- [ ] Content-Security-Policy: on by default in production builds (`MAIL_CSP` unset = `enforce`, #118). If a page
      breaks after a deploy, `MAIL_CSP=report-only` is the switch; `docs/deploy/csp.md`.
- [ ] Monitoring: wire the alerts in `docs/ops/alerts.md` (#125) to Logpush (US) and Cloud Logging / Monitoring
      (RU, logs kept in `ru-central1`). Optional `MAIL_REQUEST_LOG=on` adds a scrubbed line per request.

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
- [ ] Deploy with **Actions → Deploy US (Cloudflare)** (#80): manual only, `production-us` environment (add
      required reviewers and the secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `HYPERDRIVE_ID`, plus
      `BETTER_AUTH_SECRET` for the API worker). `scripts/deploy-guard.mjs` refuses `cumulus-mail`, routes,
      Email Routing, send_email and R2 before anything is uploaded.
- [ ] Before the first real deploy: `npm run deploy:dry-run` (#117, `docs/deploy/dry-run.md`) builds both workers
      with the production config, runs them locally against a throwaway database and checks every module made it
      in. (#124 fixed the database guard for Hyperdrive's own connection string; it is on `main`.)
- [ ] Check: `node scripts/smoke.mjs --host https://cumulus-mail-api.<account>.workers.dev` (#82, `/api/health` from #78).
- [ ] Then follow `docs/deploy/cutover.md` (#83): real-database probe, catch-all, custom domain, each with rollback.
- [ ] Settings reach the API worker by prefix (`MAIL_`, `STRIPE_`, `BILLING_`, `CID_`, `CUMULUS_`, ...; #72).
- [ ] After the catch-all cutover and once SPF/DKIM/DMARC are published (§6): set `MAIL_AUTH_DNS=live` on the
      inbound worker. Until then every sender's SPF/DKIM/DMARC result is `none`, so spoofed mail is not quarantined.

## 3. RU: Yandex Cloud (`docs/deploy/yandex-ru.md`, PR #76)

- [ ] **Decisions first** (in the runbook): where Russian users' data and blobs live (152-FZ: Managed
      PostgreSQL + Object Storage in `ru-central1`, or the shared Supabase project in `eu-west-1`); how inbound
      mail reaches Russian mailboxes; a scheduler for scheduled send / outbound queue; Serverless Container or VM.
- [ ] Yandex Cloud folder, Container Registry, a service account (image pull, Lockbox read, bucket access).
- [ ] Lockbox secret with `BETTER_AUTH_SECRET`, `DATABASE_URL`, `MAIL_BLOB_KEY`, `MAIL_BLIND_KEY`,
      `MAIL_S3_ACCESS_KEY_ID`, `MAIL_S3_SECRET_ACCESS_KEY`, `CRON_SECRET`.
- [ ] If RU gets its own database: apply every file in `migrations/` there (`DATABASE_URL=… node
      scripts/migrate.mjs`; `npm run db:status` to check), recorded in `public._migrations`.
- [ ] Scheduler (#88): `CRON_SECRET` (32+ random characters), and a Yandex Cloud trigger (timer, every minute) that
      calls `POST https://ru.mail.cumuluscloud.app/api/cron/tick` with `Authorization: Bearer <CRON_SECRET>`.
      Without it, scheduled send, snoozes and the outbound retry queue do not run on the Russia copy
      (runbook, "`CRON_SECRET` — RU scheduler").
- [ ] Legal pages (#97): `/legal/privacy` and `/legal/terms` on the Russia copy are shown as drafts until every operator field is
      filled **and** `MAIL_LEGAL_RU_REVIEWED=yes`. Set that only after a lawyer has checked the wording
      (`docs/legal-ru.md`).
- [ ] Deploy with **Actions → Deploy RU (Yandex Cloud)** (#81; `production-ru` environment with the secret
      `YC_SA_KEY_JSON` and vars `YC_CLOUD_ID`, `YC_FOLDER_ID`, `YC_REGISTRY_ID`, `YC_SA_ID`, `YC_LOCKBOX_ID`), or
      by hand: `REGISTRY_ID=… SA_ID=… LOCKBOX_ID=… ./deploy/yandex/deploy.sh` (asks before acting).
- [ ] Check before DNS: `node scripts/smoke.mjs --host https://<id>.apigw.yandexcloud.net --region ru`.
- [ ] API Gateway (or ALB) with the `ru.mail.cumuluscloud.app` certificate; DNS for it (owner). Keep it off
      Cloudflare so it loads in Russia without a VPN.
- [ ] Check after DNS: `node scripts/smoke.mjs --host https://ru.mail.cumuluscloud.app` all ok (region `ru`, not
      via AWS/Cloudflare, sign-in through `ru.id.cumuluscloud.app` per #79); sign in once from Russia without a VPN.

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
- [ ] SPF and DMARC records that include the relay. The exact records, and how to check them once published, are in
      `docs/deploy/dns-records.md` (#122); `npm run dkim:record` prints the DKIM TXT record from the key.
- [ ] Optional rate limits: `MAIL_OUTBOUND_HOURLY_LIMIT` (default 100), `MAIL_OUTBOUND_DAILY_LIMIT` (default 500).
- [ ] Know what the abuse controls do (#126), so support can answer: only mailboxes whose Cumulus ID email is
      verified send outside Cumulus; a new mailbox starts at 10/hour and 20/day and reaches the limits above after
      7 days; a burst of spam-shaped mail pauses outside sending for 24 hours, with the reason shown in the
      Outbox. A pause is a row in `cumulus_mail.outbound_pauses`; deleting it lifts it early.

Without `MAIL_SMTP_HOST`, outside mail stays held in the Outbox as it does today.

## 7. Before turning things on

- [ ] `npm run test:e2e` on `main` (browser smoke tests, local mode); CI runs it and the Docker image check.
- [ ] `npm run drill:restore` once against a staging copy (runbook §9), and keep the timings as the measured RTO.
- [ ] Send one message to an outside address after the first deploy and check it arrives with SPF, DKIM and DMARC
      passing (look at the received headers, or use a mail-tester service). This was never run against a real relay.
- [ ] `node scripts/smoke.mjs` against each region's real database and storage.
