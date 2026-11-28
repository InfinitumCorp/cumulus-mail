# Ship today: the commands, in order

One person, about **2 hours**. This is the short version of `friday.md`: same order, same checks, only the
commands, what each one must print, and when to stop. When a step says **STOP**, do that step's rollback and
do not go on; every step before **5** is invisible to users.

**Deploy commit:** `main` at or after `68722aa` (everything is merged). Write it down: `____________`

This page holds **names only**. No value of any secret belongs in this repository, in a shell history you
share, or in chat.

---

## Before you start (have these ready)

| What | Why | Check |
|---|---|---|
| **Cloudflare account on Workers Paid** | Free allows 10 ms CPU per request; a mailbox save uses about 44 ms | Workers & Pages → Plans |
| Cloudflare: owner access to the account and the `cumuluscloud.app` zone (Workers, Email Routing, DNS) | steps 3–6 | |
| Cloudflare API token: Workers Scripts edit + Hyperdrive read | the deploy workflow | `npx wrangler whoami` with it |
| **Hyperdrive caching off** on `cumulus-mail` | stale reads after writes (sessions, factors, routes) | `npx wrangler hyperdrive get d07a82ac7fcc42ac84dc6469140ef551` → `"caching": { "disabled": true }`; if not, `npx wrangler hyperdrive update d07a82ac7fcc42ac84dc6469140ef551 --caching-disabled` |
| **DNS TTL of `mail` and `ru.mail` at 60 s** | fast rollback | lower it **now**: it must have been 60 s for one *old* TTL period before step 5 |
| GitHub admin on the repo | environments `production-us` and `production-ru` | Settings → Environments |
| Supabase project `percackrrhhreusasspr`: database password (session pooler, port 5432) and a Storage S3 key pair | migrations, the workers | |
| Yandex Cloud (RU): folder, Container Registry, runtime service account, Lockbox secret, deploy service-account key, certificate for `ru.mail.cumuluscloud.app`, an API Gateway | steps 7–8 | `docs/deploy/yandex-ru.md` "What the owner must supply" |
| Cumulus ID: the `cumulus-mail` client lists `https://mail.cumuluscloud.app` and `https://ru.mail.cumuluscloud.app` | sign-in | |
| A password manager open | every new key is written there **first** | |
| Optional: an SMTP relay account and a DKIM key | outside mail (step 9); without it outside mail waits in the Outbox | |
| Someone in Russia without a VPN | step 8 | |

**Decided before go:** `MAIL_SPAM_FEEDS=off` at launch (recommended, #86); RU D1–D6 (`docs/deploy/yandex-ru.md`).
With D1 (a), Russian mailboxes **do not receive outside mail** until D3 is designed; they can still send and
read. Billing stays off unless Stripe is configured.

### Names to set (values only in the platforms)

```text
openssl rand -hex 32   -> MAIL_BLOB_KEY      (US; use the same value for MAIL_BLIND_KEY)
openssl rand -hex 32   -> BETTER_AUTH_SECRET (US)
openssl rand -hex 32   -> MAIL_BLOB_KEY, BETTER_AUTH_SECRET, CRON_SECRET (RU: different values from US)
```

| Where | Names |
|---|---|
| GitHub environment `production-us`, secrets | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `HYPERDRIVE_ID` (`d07a82ac7fcc42ac84dc6469140ef551`), `MAIL_BLOB_KEY`, `MAIL_BLIND_KEY`, `SUPABASE_S3_ACCESS_KEY_ID`, `SUPABASE_S3_SECRET_ACCESS_KEY`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (= `https://cumulus-mail-api.<account>.workers.dev` until step 5) |
| GitHub environment `production-ru` | secret `YC_SA_KEY_JSON`; variables `YC_CLOUD_ID`, `YC_FOLDER_ID`, `YC_REGISTRY_ID`, `YC_SA_ID`, `YC_LOCKBOX_ID` |
| Yandex Lockbox (the `YC_LOCKBOX_ID` secret) | `BETTER_AUTH_SECRET`, `DATABASE_URL`, `MAIL_BLOB_KEY`, `MAIL_S3_ACCESS_KEY_ID`, `MAIL_S3_SECRET_ACCESS_KEY`, `CRON_SECRET` (32+ characters) |
| Worker variables, after step 3 (Workers → the worker → Settings → Variables; kept across deploys) | `cumulus-mail-inbound`: `MAIL_SPAM_FEEDS=off`. Later: `MAIL_AUTH_DNS=live` (step 6); with a relay, `MAIL_SMTP_HOST`, `MAIL_SMTP_PORT`, `MAIL_SMTP_USER`, secret `MAIL_SMTP_PASSWORD`, `MAIL_DKIM_SELECTOR`, secret `MAIL_DKIM_PRIVATE_KEY`, on **both** workers |

The deploy workflow copies the `production-us` app secrets onto both workers on every run, so set them once
there. The RU app secrets never pass through GitHub.

---

## 0. Check out the deploy commit (5 min)

```sh
git fetch origin && git checkout --detach origin/main && git log -1 --oneline
npm ci
```

**Expected:** the commit you wrote down. On GitHub, CI on that commit is green (`check`, `worker-smoke`,
`e2e`, `perf`, `docker`). **STOP** if any is red.

## 1. Rehearsal: what is missing (10 min)

In a shell with that region's settings exported (the same values you stored; nothing is printed):

```sh
npm run cutover:check -- --region us --selector <DKIM selector>   # DATABASE_URL = the US pooler URL
npm run cutover:check -- --region ru --no-dns                     # DATABASE_URL = the RU database
```

**Expected, US:** `WARN 3 migration(s) to apply, in this order: 0022_factor_sessions.sql,
0023_outbound_queue_created.sql, 0024_save_sequences.sql`; `ok anon is refused on public.session`;
`WARN MAIL_AUTH_DNS is not live`; `WARN MAIL_SMTP_HOST is not set` (no relay yet); SPF, DKIM, DMARC MISSING
(step 6 publishes them); MTA-STS and TLS-RPT WARN.
**Expected, RU (new database):** every file in `migrations/`, `0001_auth.sql` first;
`WARN public.session does not exist yet`; `WARN MAIL_LEGAL_RU_REVIEWED` until the lawyer's review is recorded.
**STOP** on any other MISSING (a secret, the Hyperdrive id, the token issuer), or on
`Migrations skipped in the middle`.

## 2. Migrate (10 min)

From the deploy commit, before deploying it:

```sh
npm run db:status      # US: lists 0022, 0023, 0024; exit 3
npm run db:migrate     # "applied …" for each, then "done — 3 migration(s) applied"
npm run db:status      # "up to date", exit 0
npm run cutover:check -- --region us      # still: ok anon is refused on public.session
```

RU: the same three commands with the RU `DATABASE_URL` (every file).
**STOP** if `db:migrate` errors. Every migration is additive; the old page worker ignores the new tables,
so there is nothing to roll back. Per-file undo, if ever needed: `docs/ops/migrations.md`.

## 3. Deploy US next to the old site (10 min)

GitHub → Actions → **Deploy US (Cloudflare)** → Run workflow → branch `main`, `target: both`,
confirmation `deploy us`. Or:

```sh
gh workflow run deploy-cloudflare.yml --ref main -f target=both -f confirm="deploy us"
gh run watch
```

It runs lint, typecheck and the tests, then the guard (`scripts/deploy-guard.mjs`: never the page worker
`cumulus-mail`, no routes, no custom domains, no R2, no `send_email`), puts the secrets and deploys
`cumulus-mail-inbound` and `cumulus-mail-api`. A first run creates the workers.
**Expected:** green; `npx wrangler deployments list --name cumulus-mail-api` shows today's deploy.
Then set `MAIL_SPAM_FEEDS=off` on `cumulus-mail-inbound` (variables table above).
**STOP** if red: nothing user-facing changed. Rollback: leave or delete the two new workers.

## 4. Verify US on its own URL (10 min)

```sh
npm run verify:live -- --region us --url https://cumulus-mail-api.<account>.workers.dev --commit <deploy commit>
```

**Expected:** `ok: all … checks pass`. That is: health ok, region us, schema current; the app page;
sign-in redirects to `id.cumuluscloud.app` with PKCE; CSP with a nonce, no grok.com, HSTS; protected
endpoints refuse anonymous calls; robots (`/` is `noindex` on the workers.dev host); the commit.
Then, in a browser on that URL:
- sign in, end to end, and sign out;
- sign in again and out again;
- reload `/api/health?deep=1` a few times: `"status":"ok"` every time.

**STOP** on any FAIL: users have seen nothing. Rollback as step 3.

## 5. Cutover US: inbound, then the web host (15 min)

1. Cloudflare → Email Routing → catch-all: `cumulus-mail` → **`cumulus-mail-inbound`**. Send a message
   from an outside account to your mailbox.
2. Workers → `cumulus-mail` → Domains: remove `mail.cumuluscloud.app`; `cumulus-mail-api` → Domains: add
   it. Back to back.
3. `production-us` → `BETTER_AUTH_URL` = `https://mail.cumuluscloud.app`, then re-run the deploy with
   `target: api`.

```sh
npm run verify:live -- --region us --commit <deploy commit>
npm run smoke -- --url https://mail.cumuluscloud.app --domain cumuluscloud.app     # adds the MX check
```

**Expected:** all ok (robots: `/` indexable on the production name); `mx` is Cloudflare Email Routing.
Sign in and see the message from 5.1.
Then add the four rate-limiting rules in `docs/deploy/edge-rate-limits.md`, in **Log** mode.
**STOP / rollback:** the custom domain back to `cumulus-mail`, the catch-all back to `cumulus-mail`,
`BETTER_AUTH_URL` back to the workers.dev origin (re-run `target: api`). The old worker was never changed.

## 6. Mail authentication DNS (10 min + propagation; can wait until later today)

Publish SPF, DKIM and DMARC as in `docs/deploy/dns-records.md` (US #2–#4; the DKIM record from
`npm run dkim:record -- dkim.pem <selector> cumuluscloud.app`).

```sh
npm run preflight -- --region us --selector <selector>    # SPF, DKIM and DMARC now ok
```

Then `MAIL_AUTH_DNS=live` on `cumulus-mail-inbound`, and re-run the deploy with `target: inbound`.
**Expected:** a Gmail message arrives with `dmarc=pass` in the worker log (`mail.inbound.auth`).
**Rollback:** unset `MAIL_AUTH_DNS`. Leave the records.

## 7. Deploy RU (10 min)

GitHub → Actions → **Deploy RU (Yandex Cloud)** → branch `main`, confirmation `deploy ru`. Or:

```sh
gh workflow run deploy-yandex.yml --ref main -f confirm="deploy ru"
gh run watch
npm run verify:live -- --region ru --url https://<gateway id>.apigw.yandexcloud.net --commit <deploy commit>
```

**Expected:** green; then all ok, region `ru`, sign-in through `ru.id.cumuluscloud.app`, robots (`/` is
`noindex` on the gateway host).
**STOP / rollback:** Yandex console → Serverless Containers → `cumulus-mail-ru` → Revisions → the
previous revision. Users still reach the old page.

## 8. RU cutover and its scheduler (15 min)

1. DNS: `ru.mail` → the Yandex API Gateway, **DNS only, not proxied by Cloudflare**.
2. Yandex timer trigger, every minute: `POST https://ru.mail.cumuluscloud.app/api/cron/tick` with
   `Authorization: Bearer <CRON_SECRET>`. One call must answer **200** with counts. 401: wrong secret.
   404: no `CRON_SECRET` (or shorter than 32 characters) on the container.
3. In the container's request log, one request's `x-forwarded-for` holds **one** address. A chain means
   `BETTER_AUTH_TRUSTED_PROXIES` is needed (`friday.md` step 9.3).

```sh
npm run verify:live -- --region ru --commit <deploy commit>
```

**Expected:** all ok, including `ru-path` (no `cf-ray`, no `apigw-requestid`). The tester in Russia signs
in without a VPN and sees the inbox in Russian.
**STOP / rollback:** restore the old DNS record (60 s TTL) and disable the timer.

## 9. The first outside send (10 min, with a relay)

Set the `MAIL_SMTP_*` and `MAIL_DKIM_*` names on **both** workers (variables table above). Send from a
Cumulus mailbox to a Gmail address you own and open "Show original".
**Expected:** `SPF: PASS`, `DKIM: PASS` with `d=cumuluscloud.app`, `DMARC: PASS`, in the inbox. This is also
the first real check of the relay's TLS from Workers (`cloudflare:sockets`, #219), which cannot be tested
before.
**Rollback:** unset `MAIL_SMTP_HOST`; outside mail waits in the Outbox.

## 10. Watch (rest of the day)

```sh
npm run verify:live -- --region us
npm run verify:live -- --region ru
```

Every hour or two. Alerts: `docs/ops/alerts.md` (Inbound failing, Outbound bounces, CSP violations,
Deletion overdue). Leave the old worker `cumulus-mail` untouched for a week. Raise the TTLs tomorrow; switch
the rate rules to Block tomorrow if nothing legitimate was logged.

---

## Rollback for a bad deploy (any time)

1. **US:** Cloudflare → Workers → `cumulus-mail-api` (and/or `cumulus-mail-inbound`) → Deployments → the
   previous version → Rollback. **RU:** Serverless Containers → `cumulus-mail-ru` → Revisions → previous.
2. **Check:** `npm run verify:live -- --region us|ru --commit <previous commit>`.
3. **Roll forward** once the fix is on `main`: re-run the deploy workflow, then `verify:live --commit`.

No migration is ever undone for a rollback: the previous build runs on the migrated database.
Per-symptom first moves (site down, CSP breakage, mail not arriving, quarantine, bounces, RU unreachable):
the table in `friday.md` and `docs/ops/incident.md`.

## What "before" looks like (27–28 Nov)

`npm run verify:live -- --region us` and `-- --region ru` against today's hosts fail by design. They report:
- health 404 (the new app is not there);
- the old page worker (`cumulus-config.js`);
- no sign-in redirect;
- a CSP without a nonce;
- a `robots.txt` without the `/api/` and `/_serverFn/` lines;
- no commit;
- for RU, also `ru-path`: served through AWS API Gateway and Cloudflare.

`api-auth` already passes. After step 5 (US) and step 8 (RU) every line must be ok.
