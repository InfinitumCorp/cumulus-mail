# Ship today: the commands, in order

One person, about **2 hours**. This is the short version of `friday.md`: same order, same checks, only the
commands, what each one must print, and when to stop. When a step says **STOP**, do that step's rollback and
do not go on. Steps 0–4 are invisible to users; the first user-facing change is 5.1.

**Deploy commit:** `main` at or after the merge of the PR that added this page and `npm run verify:live`.
Write it down: `____________`. **Merge nothing else to `main` until step 8 is done:** both deploy
workflows build `main`'s tip at the moment you start them, and `verify:live --commit` checks for exactly the
commit you wrote down.

This page holds **names only**. No value of any secret belongs in this repository, in a shared shell history,
or in chat. Use one shell per region, so the US and RU values never mix. Every `wrangler` below is the version
the workflow pins: `npx --yes wrangler@4.157.0`.

---

## Before you start (have these ready)

| What | Why | Check |
|---|---|---|
| **Cloudflare account on Workers Paid** | Free allows 10 ms CPU per request; a mailbox save uses about 44 ms | Workers & Pages → Plans |
| Cloudflare: owner access to the account and the `cumuluscloud.app` zone (Workers, Email Routing, DNS); the account's **workers.dev subdomain** registered | steps 3–6 | Workers & Pages → your subdomain (register one if there is none) |
| Cloudflare API token: Workers Scripts edit + Hyperdrive read | the deploy workflow | `npx --yes wrangler@4.157.0 whoami` with it |
| **Hyperdrive caching off** on `cumulus-mail` | stale reads after writes (sessions, factors, routes) | `npx --yes wrangler@4.157.0 hyperdrive get d07a82ac7fcc42ac84dc6469140ef551` shows `"caching": { "disabled": true }`; if not, `… hyperdrive update d07a82ac7fcc42ac84dc6469140ef551 --caching-disabled` |
| **DNS TTL of `mail` and `ru.mail` at 60 s** | fast rollback | lower it **now**: it must have been 60 s for one *old* TTL period before step 5 |
| GitHub admin on the repo; you can approve the `production-us` and `production-ru` environments | the deploy workflows wait for that approval | Settings → Environments |
| Supabase `percackrrhhreusasspr`: database password (session pooler, port 5432) and a Storage S3 key pair | migrations, the workers, the inbound probe | |
| Yandex Cloud (RU): folder, Container Registry, runtime service account, Lockbox secret, deploy service-account key, certificate for `ru.mail.cumuluscloud.app`, an API Gateway | steps 7–8 | `docs/deploy/yandex-ru.md` "What the owner must supply" |
| Cumulus ID: the `cumulus-mail` client lists `https://mail.cumuluscloud.app`, `https://ru.mail.cumuluscloud.app` and, for step 4, `https://cumulus-mail-api.<subdomain>.workers.dev` | sign-in returns codes only to listed origins | without the workers.dev entry, skip step 4's browser sign-in and do it in step 5 |
| A password manager open | every new key is written there **first** | |
| An SMTP relay account and a DKIM key | outside mail (step 9) and SPF/DKIM (step 6). Without them, outside mail waits in the Outbox and step 6 waits too | `docs/deploy/outbound-smtp.md` |
| Someone in Russia without a VPN | step 8 | |

**Decided before go:**
- `MAIL_SPAM_FEEDS=off` at launch (recommended in #86).
- RU D1–D6 (`docs/deploy/yandex-ru.md`). With D1 (a), Russian mailboxes **do not receive outside mail** until D3 is designed; they can still read, and send internally.
- The old page worker's data (`docs/deploy/cutover.md`, Decisions 1). Step 5.1 moves the catch-all for every address.
- Stripe prices, or billing left off, and the grandfathering choice (launch checklist §4–§5).
- A lawyer's review of the Russian legal pages, or accepting that they show as drafts.
- RU outside mail stays in the Outbox at launch: `deploy/yandex/deploy.sh` cannot mount `MAIL_SMTP_PASSWORD` or `MAIL_DKIM_PRIVATE_KEY` yet.

### Names to set (values only in the platforms)

```text
openssl rand -hex 32   -> US MAIL_BLOB_KEY    (also the value of US MAIL_BLIND_KEY)
openssl rand -hex 32   -> US BETTER_AUTH_SECRET
openssl rand -hex 32   -> RU MAIL_BLOB_KEY    (also the value of RU MAIL_BLIND_KEY; different from US)
openssl rand -hex 32   -> RU BETTER_AUTH_SECRET
openssl rand -hex 32   -> RU CRON_SECRET
```

| Where | Names |
|---|---|
| GitHub environment `production-us`, secrets | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `HYPERDRIVE_ID` (`d07a82ac7fcc42ac84dc6469140ef551`; optional, the id is committed), `MAIL_BLOB_KEY`, `MAIL_BLIND_KEY`, `SUPABASE_S3_ACCESS_KEY_ID`, `SUPABASE_S3_SECRET_ACCESS_KEY`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (= `https://cumulus-mail-api.<subdomain>.workers.dev` until step 5) |
| GitHub environment `production-ru` | secret `YC_SA_KEY_JSON`; variables `YC_CLOUD_ID`, `YC_FOLDER_ID`, `YC_REGISTRY_ID`, `YC_SA_ID`, `YC_LOCKBOX_ID`, and `YC_LOCKBOX_OPTIONAL_KEYS` = `MAIL_BLIND_KEY` |
| Yandex Lockbox (the `YC_LOCKBOX_ID` secret) | `BETTER_AUTH_SECRET`, `DATABASE_URL`, `MAIL_BLOB_KEY`, `MAIL_BLIND_KEY`, `MAIL_S3_ACCESS_KEY_ID`, `MAIL_S3_SECRET_ACCESS_KEY`, `CRON_SECRET` (32+ characters) |
| Worker variables, after step 3 (Workers → the worker → Settings → Variables; take effect when saved and are kept across deploys) | `cumulus-mail-inbound`: `MAIL_SPAM_FEEDS=off`. Later: `MAIL_AUTH_DNS=live` (step 6). With a relay, on **both** workers: `MAIL_SMTP_HOST`, `MAIL_SMTP_PORT`, `MAIL_SMTP_USER`, `MAIL_DKIM_SELECTOR`, and the secrets `MAIL_SMTP_PASSWORD` and `MAIL_DKIM_PRIVATE_KEY` |

A deploy run puts the `production-us` app secrets onto the worker(s) it targets, only those that are set.
Clearing a GitHub secret does not remove it from a worker. The RU app secrets never pass through GitHub.

---

## 0. Check out the deploy commit (5 min)

```sh
git fetch origin && git checkout --detach origin/main && git log -1 --oneline
npm ci
```

**Expected:** the commit you wrote down. On GitHub, CI on that commit is green (`check`, `worker-smoke`,
`e2e`, `perf`, `docker`). **STOP** if any is red.

## 1. Rehearsal: what is missing (10 min)

US shell: export `BETTER_AUTH_SECRET`, `MAIL_BLOB_KEY`, `MAIL_BLIND_KEY`, `BETTER_AUTH_URL`,
`SUPABASE_S3_ACCESS_KEY_ID`, `SUPABASE_S3_SECRET_ACCESS_KEY` and `DATABASE_URL` (the US pooler URL below).
RU shell: `BETTER_AUTH_SECRET`, `MAIL_BLOB_KEY`, `MAIL_BLIND_KEY`, `DATABASE_URL`, `MAIL_S3_ACCESS_KEY_ID`,
`MAIL_S3_SECRET_ACCESS_KEY`, `CRON_SECRET`. The values are the ones you stored; nothing is printed.

```sh
npm run cutover:check -- --region us --selector <DKIM selector>
npm run cutover:check -- --region ru --no-dns
```

**Expected, US:**
- `WARN 3 migration(s) to apply, in this order: 0022_factor_sessions.sql, 0023_outbound_queue_created.sql, 0024_save_sequences.sql`;
- `ok anon is refused on public.session (permission denied)`;
- `WARN MAIL_AUTH_DNS is not live` and `WARN MAIL_SMTP_HOST is not set`;
- SPF, DKIM and DMARC **MISSING** (step 6 publishes them), MTA-STS and TLS-RPT WARN;
- it ends `NOT READY: 1 blocking item(s) (preflight failed, see above).` That is right at this point: the only missing items must be SPF, DKIM and DMARC.

**Expected, RU (Yandex Managed PostgreSQL, a new database):**
- every file in `migrations/`, `0001_auth.sql` first;
- `ok No anon role in this database (not Supabase): nothing to lock down`. On a new Supabase database it is `WARN public.session does not exist yet` instead;
- `WARN MAIL_SMTP_HOST is not set` and `WARN MAIL_LEGAL_RU_REVIEWED is not yes`;
- it ends `READY for the RU cutover (warnings, if any, are listed above).`

(Output lines are padded, e.g. `WARN    …`.)
**STOP** on any other MISSING (a secret, the token issuer), or on `Migrations skipped in the middle`.

## 2. Migrate (10 min)

From the deploy commit, before deploying it. US shell:

```sh
export DATABASE_URL="postgresql://postgres.percackrrhhreusasspr:<database-password>@aws-1-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require"
npm run db:status      # "[migrate] pending 0022_…", "… 0023_…", "… 0024_…", "[migrate] 3 pending.", exit 3 (npm adds an error footer: expected)
npm run db:migrate     # "[migrate] applied …" for each, then "[migrate] done — 3 migration(s) applied."
npm run db:status      # "[migrate] up to date.", exit 0
npm run cutover:check -- --region us      # still: ok anon is refused on public.session
```

RU shell: the same three `db:` commands with the RU `DATABASE_URL` (every file).
**STOP** if any command prints `DATABASE_URL not set — skipping` (it exits 0 but did nothing), or if
`db:migrate` errors. Every migration is additive; the old page worker ignores the new tables, so there is
nothing to roll back. Per-file undo, if ever needed: `docs/ops/migrations.md`.

## 3. Deploy US next to the old site (10 min)

GitHub → Actions → **Deploy US (Cloudflare)** → Run workflow → branch `main`, **`target: both`** (the
default is `inbound`), confirmation `deploy us`. Approve the `production-us` review when asked. Or:

```sh
gh workflow run deploy-cloudflare.yml --ref main -f target=both -f confirm="deploy us"
sleep 5; gh run watch "$(gh run list --workflow deploy-cloudflare.yml --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status
```

The run waits at "Waiting for review" until you approve the environment. Then it runs lint, typecheck and
the tests, and the guard (`scripts/deploy-guard.mjs`: never the page worker `cumulus-mail`, no routes, no
custom domains, no R2, no `send_email`). It puts the secrets, and deploys `cumulus-mail-inbound` and
`cumulus-mail-api`. A first run creates the workers.
**Expected:** the `deploy` job ran (not skipped: off `main` it is skipped, grey) and is green;
`npx --yes wrangler@4.157.0 deployments list --name cumulus-mail-api` shows today's deploy.
Then set `MAIL_SPAM_FEEDS=off` on `cumulus-mail-inbound` (variables table above).
**STOP** if red: nothing user-facing changed. Rollback: leave or delete the two new workers.

## 4. Verify US on its own URL (15 min)

```sh
npm run verify:live -- --region us --url https://cumulus-mail-api.<subdomain>.workers.dev --commit <deploy commit>
```

**Expected:** `ok: all N checks pass` (N is 8 when the host is behind Cloudflare). That is:
- health ok, region us, schema current;
- the app page;
- sign-in redirects to `id.cumuluscloud.app` with PKCE;
- CSP with a nonce, no grok.com, HSTS;
- protected endpoints refuse anonymous calls;
- robots: `/` is `noindex` on the workers.dev host;
- the commit.

Then, in a browser on that URL (needs the workers.dev origin listed in Cumulus ID, see above):
- sign in, end to end, and sign out;
- sign in again and out again;
- reload `/api/health?deep=1` a few times: `"status":"ok"` every time.

Then the real-database inbound probe, required before the catch-all moves. In the US shell:

```sh
export CUMULUS_ALLOW_SUPABASE=1 MAIL_INBOUND_LIVE=1 HYPERDRIVE_CONNECTION_STRING="$DATABASE_URL"
export SUPABASE_S3_ENDPOINT="https://percackrrhhreusasspr.storage.supabase.co/storage/v1/s3" SUPABASE_S3_REGION=us-east-1 SUPABASE_S3_BUCKET=cumulus-mail
node --experimental-strip-types scripts/smoke.mjs     # MAIL_BLOB_KEY and SUPABASE_S3_* keys already exported
```

**Expected:** `[smoke] inbound live probe stored ciphertext`. The probe deletes its test row and object.
**STOP** on any FAIL or `[smoke]` error line: users have seen nothing. Rollback as step 3.

## 5. Cutover US: inbound, then the web host (15 min)

1. Cloudflare → Email Routing → catch-all: `cumulus-mail` → **`cumulus-mail-inbound`**. Send a message
   from an outside account to your mailbox.
2. Workers → `cumulus-mail` → Domains: remove `mail.cumuluscloud.app`; `cumulus-mail-api` → Domains: add
   it. Back to back.
3. **Immediately**, so sign-in does not bounce users to workers.dev:

   ```sh
   printf '%s' 'https://mail.cumuluscloud.app' | npx --yes wrangler@4.157.0 secret put BETTER_AUTH_URL --name cumulus-mail-api
   ```

   It takes effect at once. Then set the `production-us` secret `BETTER_AUTH_URL` to the same value, so later
   deploy runs keep it.

```sh
npm run verify:live -- --region us --commit <deploy commit>
npm run smoke -- --url https://mail.cumuluscloud.app --domain cumuluscloud.app     # adds the MX check
```

**Expected:**
- all ok, and robots: `/` indexable on the production name;
- `mx` is Cloudflare Email Routing;
- sign in, and see the message from 5.1.

Then add the rate-limiting rules in `docs/deploy/edge-rate-limits.md`, in **Log** mode. The Free zone plan
allows one rule; the zone plan is separate from Workers Paid.
**STOP / rollback:**
- move the custom domain back to `cumulus-mail`;
- move the catch-all back to `cumulus-mail`;
- put the workers.dev origin back with the same `secret put` command, and in `production-us`.

The old worker was never changed.

## 6. Mail authentication DNS (10 min + propagation; needs the relay and DKIM key; can wait)

Publish SPF (with the relay's include), DKIM and DMARC as in `docs/deploy/dns-records.md` (US #2–#4).
The DKIM record comes from `npm run dkim:record -- dkim.pem <selector> cumuluscloud.app`.

```sh
npm run preflight -- --region us --selector <selector>    # SPF, DKIM and DMARC now ok
```

Then set `MAIL_AUTH_DNS=live` on `cumulus-mail-inbound`. It takes effect when saved.
**Expected:** a Gmail message arrives with `dmarc=pass` in the worker log (`mail.inbound.auth`).
**Rollback:** unset `MAIL_AUTH_DNS`. Leave the records.
Without a relay yet: skip this step and step 9. Outside mail waits in the Outbox, and inbound is delivered
without SPF/DKIM/DMARC checks.

## 7. Deploy RU (15 min)

GitHub → Actions → **Deploy RU (Yandex Cloud)** → branch `main`, confirmation `deploy ru`. Approve the
`production-ru` review when asked. Or:

```sh
gh workflow run deploy-yandex.yml --ref main -f confirm="deploy ru"
sleep 5; gh run watch "$(gh run list --workflow deploy-yandex.yml --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status
```

The first run creates the container `cumulus-mail-ru`. Then point the API Gateway's
`serverless_containers` integration for `/{proxy+}` at it (`docs/deploy/yandex-ru.md` step 6), and:

```sh
npm run verify:live -- --region ru --url https://<gateway id>.apigw.yandexcloud.net --commit <deploy commit>
```

**Expected:** every line ok except one:

`FAIL sign-in: callback https://ru.mail.cumuluscloud.app/… is not on https://<gateway id>.apigw.yandexcloud.net`

and the summary `FAIL 1 of 8 checks: sign-in`. That is right before the DNS switch: the container's
`BETTER_AUTH_URL` is already `https://ru.mail.cumuluscloud.app`. Health says region `ru`, and robots finds `/`
`noindex` on the gateway host.
**STOP / rollback:** Yandex console → Serverless Containers → `cumulus-mail-ru` → Revisions → the
previous revision. Users still reach the old page.

## 8. RU cutover and its scheduler (15 min)

1. Write down the current `ru.mail` DNS record (the rollback needs it). Attach the
   `ru.mail.cumuluscloud.app` certificate and domain to the gateway. Then point `ru.mail` at the gateway,
   **DNS only, not proxied by Cloudflare** (`docs/deploy/cutover.md` Phase 3).
2. Yandex timer trigger, every minute: `POST https://ru.mail.cumuluscloud.app/api/cron/tick` with
   `Authorization: Bearer <CRON_SECRET>`.
   - One call must answer **200** with counts.
   - 401 means the wrong secret.
   - 404 means no `CRON_SECRET` on the container, or one shorter than 32 characters.
3. In the container's request log, one request's `x-forwarded-for` holds **one** address. A chain means
   `BETTER_AUTH_TRUSTED_PROXIES` is needed (`friday.md` step 9.3).

```sh
npm run verify:live -- --region ru --commit <deploy commit>
```

**Expected:** `ok: all 8 checks pass`, now including sign-in, and `ru-path` (no `cf-ray`, no `apigw-requestid`). The tester
in Russia signs in without a VPN and sees the inbox in Russian.
**STOP / rollback:** restore the recorded DNS record (60 s TTL) and disable the timer.

## 9. The first outside send (10 min, US, with a relay)

Set the `MAIL_SMTP_*` and `MAIL_DKIM_*` names on **both** US workers (variables table above). Send from a
Cumulus mailbox to a Gmail address you own and open "Show original".
**Expected:** `SPF: PASS`, `DKIM: PASS` with `d=cumuluscloud.app`, `DMARC: PASS`, in the inbox. This is also
the first real check of the relay's TLS from Workers (`cloudflare:sockets`, #219), which cannot be tested
before.
**Rollback:** unset `MAIL_SMTP_HOST` on both workers; outside mail waits in the Outbox.

## 10. Watch (rest of the day)

```sh
npm run verify:live -- --region us
npm run verify:live -- --region ru
```

Run both every hour or two. Watch the alerts in `docs/ops/alerts.md`: Inbound failing, Outbound bounces,
CSP violations, Deletion overdue.
- Leave the old worker `cumulus-mail` untouched for a week.
- Raise the TTLs tomorrow.
- Switch the rate rules to Block tomorrow if nothing legitimate was logged.
- After step 8, other PRs may merge again.

---

## Rollback for a bad deploy (any time)

1. **US:** Cloudflare → Workers → `cumulus-mail-api` (and/or `cumulus-mail-inbound`) → Deployments → the
   previous version → Rollback. **RU:** Serverless Containers → `cumulus-mail-ru` → Revisions → previous.
2. **Check:** `npm run verify:live -- --region us|ru --commit <previous commit>`.
3. **Roll forward** once the fix is on `main`: re-run the deploy workflow, then `verify:live --commit`.

No migration is ever undone for a rollback: the previous build runs on the migrated database.
For per-symptom first moves (site down, CSP breakage, mail not arriving, quarantine, bounces, RU
unreachable), see the table in `friday.md` and `docs/ops/incident.md`.

## What "before" looks like (28 Nov)

`npm run verify:live -- --region us --commit 68722aa` and `-- --region ru …` against today's hosts fail by
design. They report:
- health 404 (the new app is not there);
- the old page worker (`cumulus-config.js`);
- no sign-in redirect;
- a CSP without a nonce;
- a `robots.txt` without the `/api/` and `/_serverFn/` lines;
- no commit;
- for RU, also `ru-path`: served through AWS API Gateway and Cloudflare.

`api-auth` already passes. After step 5 (US) and step 8 (RU), every line must be ok.
