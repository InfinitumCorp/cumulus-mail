# Launch day: the ordered sequence (about 2 hours)

One page to follow on launch day, top to bottom. Every step has the command, what you should see, and how
to undo it. The details behind each step are in the docs linked from it; this page does not replace them,
it puts them in order.

**Who:** the owner, holding the Cloudflare, Yandex Cloud, Supabase and DNS logins. **Nothing in this
repository or its CI makes these changes**; every switch below is yours.

**Short version:** `docs/launch/owner-quickstart.md` is this page on one screen: the merge order, what to set
where, the commands in order, go/no-go and the rollback.

**Needs on `main`:** everything up to #211 (27 Nov, main 328d1d1). **Production has not been cut over yet:** on
27 Nov `mail.` and `ru.mail.` still serve the old page (no `/api/health`). Still open, merge before the deploy
commit, in this order, waiting for CI after each:
1. #214: real transactions on the pooled database (one connection from BEGIN to COMMIT). **Blocker**;
2. #216: on Workers, one Postgres pool per request (a shared pool hangs every second request). **Blocker**;
3. #217: CI `smoke:worker`, the Workers build in workerd against Postgres;
4. #213: each tab's saves are ordered on the server (migration 0024);
5. #212: a deployed copy checks WebAuthn against `https://<MAIL_APP_HOST>`, not request headers;
6. #215: a test-only e2e fix;
7. the PR that updates these pages (Hyperdrive query cache, below).

Migrations to apply at cutover (US): the dedicated database already has `0001`–`0021` (checked 26 Nov), so
`0022`, `0023` and `0024` are pending: 3 files. A new RU database applies every file.

**Decide before go:** `MAIL_SPAM_FEEDS`. Unset, inbound mail checks the sender's domain against the URLhaus host
lists (#189). Those list *websites* that served malware, often compromised small-business sites, so a legitimate
sender whose site was once hacked lands in quarantine. Each new worker isolate also downloads both lists on the
inbound path (up to 2.5 s each). Recommended for launch: `MAIL_SPAM_FEEDS=off` (worker variable, survives
deploys), and revisit with real quarantine numbers.
#86 lists the merge order and why.

**Rule for the whole day:** if a step's check does not show what is written here, stop, do that step's
rollback, and do not go on. Every step before the DNS cutover (step 6) is invisible to users.

Times are rough: steps 0–5 about 60 minutes, 6–8 about 30, 9–11 about 30.

---

## Go / no-go (the day before)

Tick every line, or move the launch.

- [ ] `main` is green in CI (check, e2e, perf, docker) on the commit you will deploy. Write the commit here: `________`
- [ ] The decisions are made: RU D1–D6 (`docs/deploy/yandex-ru.md`), Stripe prices or billing left off
      (launch checklist §4), the grandfathering choice (§5), the old worker's data (cutover "Decisions" 1).
- [ ] A lawyer has reviewed the Russian legal pages, or you accept that `/legal/privacy` and `/legal/terms`
      on `ru.mail` will show as drafts.
- [ ] The DNS TTLs for `mail` and `ru.mail` are lowered to **60 s** (do this at least one old-TTL period
      before; usually the day before).
- [ ] You have, outside the platforms, a backup of every key you are about to create (step 1).
- [ ] An SMTP relay account exists (or you accept that outside mail stays in the Outbox on day one).
- [ ] The alerts in `docs/ops/alerts.md` are wired to somewhere you will see them today.
- [ ] Someone in Russia, without a VPN, can test `ru.mail` in step 9.
- [ ] **The rehearsal passes for both regions** (read-only; nothing is written or deployed). Run it once
      the secrets exist: step 1 can be done the day before, since nothing reads them until step 4.
      In the deploy shell, with that region's secrets and `DATABASE_URL` exported:

      ```sh
      npm run cutover:check -- --region us --selector <your DKIM selector>
      npm run cutover:check -- --region ru --no-dns
      ```

      It runs preflight (secrets, repo settings, DNS), then lists pending migrations in apply order (and
      fails if one was skipped in the middle), checks that `anon` is refused on `public.session`, and checks
      the token issuer answers and names itself. **The day before, expect exactly this and nothing else:**
      - US (the dedicated database, `0001`–`0021` applied): `WARN 3 migration(s) to apply, in this order:
        0022_factor_sessions.sql, 0023_outbound_queue_created.sql, 0024_save_sequences.sql`, and `anon is refused
        on public.session` as ok;
      - a new RU database: every file in `migrations/` listed, `0001_auth.sql` first, and
        `WARN public.session does not exist yet` (0001 creates it);
      - `WARN MAIL_AUTH_DNS is not live`, and `WARN MAIL_SMTP_HOST is not set` until the relay is configured;
      - US only: SPF, DKIM and DMARC as MISSING until step 7 publishes them, and the MTA-STS and TLS-RPT
        lines as WARN;
      - RU only: `WARN MAIL_LEGAL_RU_REVIEWED` until the lawyer's review is recorded. If D1 gave Russia
        its own new database, it lists **every** file in `migrations/` (no `_migrations` table yet); that is right.
      Anything else MISSING (a secret, the Hyperdrive id, the token issuer): fix it first. A
      `Migrations skipped in the middle` line means a file other than `0001_auth.sql` was skipped: stop.
- [ ] **Hyperdrive query caching is off** on `cumulus-mail` (`d07a82ac7fcc42ac84dc6469140ef551`):
      `npx wrangler hyperdrive get d07a82ac7fcc42ac84dc6469140ef551` shows `"caching": { "disabled": true }`.
      If not: `npx wrangler hyperdrive update d07a82ac7fcc42ac84dc6469140ef551 --caching-disabled`. Caching is on
      unless disabled, and a cached read can be served after a write to the same rows. For this app,
      that would mean a signed-out session still accepted, a new second factor or alias not seen yet, rate
      limits counting late, and a reload showing the mailbox from before a save.
      `docs/deploy/cloudflare-handoff.md` §3 has the details.

---

## 0. Freeze and note the starting point (5 min)

```sh
git fetch origin && git checkout origin/main && git log -1 --oneline   # the commit from the go/no-go list
npm ci
```

Optional: set `MAIL_MAINTENANCE=1` (US: Workers → `cumulus-mail-api` → Settings → Variables, which takes
effect at once and survives later deploys (`keep_vars`); RU: a container variable, new revision) to show a "being updated" page (English and
Russian, 503 with `Retry-After: 600`) for the window. Health checks, CSP reports and the cron tick keep working, so steps 5–9 can
still check the deploy. Unset it and redeploy to open the doors.

**Rollback:** none needed.

## 1. Secrets (15 min)

Generate each key **once**, write it into your password manager first, then into the platform.

```sh
openssl rand -hex 32    # MAIL_BLOB_KEY  (use the SAME value for MAIL_BLIND_KEY)
openssl rand -hex 32    # BETTER_AUTH_SECRET
openssl rand -hex 32    # CRON_SECRET (RU)
```

**US, Cloudflare** (`docs/deploy/cloudflare-handoff.md` §6), from each worker directory:

```sh
cd workers/email && npx wrangler secret put MAIL_BLOB_KEY            # then MAIL_BLIND_KEY (same value),
                                                                       # SUPABASE_S3_ACCESS_KEY_ID, SUPABASE_S3_SECRET_ACCESS_KEY
```

The API worker's secrets are put by the deploy workflow from the `production-us` GitHub environment: add
`MAIL_BLOB_KEY`, `MAIL_BLIND_KEY`, `SUPABASE_S3_ACCESS_KEY_ID`, `SUPABASE_S3_SECRET_ACCESS_KEY`,
`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (the API worker's **workers.dev** origin for now), and
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `HYPERDRIVE_ID` there. Stripe secrets only if billing goes live today.

**RU, Yandex Lockbox** (`docs/deploy/yandex-ru.md`): `BETTER_AUTH_SECRET`, `DATABASE_URL`, `MAIL_BLOB_KEY`,
`MAIL_BLIND_KEY`, `MAIL_S3_ACCESS_KEY_ID`, `MAIL_S3_SECRET_ACCESS_KEY`, `CRON_SECRET`. The RU keys are
**different** from the US keys unless the two copies share a bucket.

**Check:** step 3 (preflight) lists anything missing.
**Rollback:** delete or replace the secret. Nothing reads them until step 4.

## 2. Database migrations (10 min)

US (dedicated Mail Supabase `percackrrhhreusasspr`, us-east-1; session pooler `aws-1-us-east-1.pooler.supabase.com`, port 5432, `sslmode=require`). Do not use the shared project `ivqiskeziohbbtkcvlun` (eu-west-1): that project stays Cloud, Fabric, Nexus, and Cumulus://ID.

```sh
export DATABASE_URL="postgresql://…:5432/postgres?sslmode=require"
npm run db:status        # lists what is pending; exit 3 if anything is
npm run db:migrate       # applies them in name order, each recorded in public._migrations
npm run db:status        # expect: nothing pending, exit 0
```

RU: the same three commands with the RU database's `DATABASE_URL` (if D1 gave Russia its own database).

**Expected:** checked 2026-11-26, the dedicated database already has `0001`–`0021`. The first `db:status` lists
`0022_factor_sessions.sql`, `0023_outbound_queue_created.sql` and `0024_save_sequences.sql` and exits 3. A new
RU database lists every file.
`db:migrate` prints `applied …` for each, in that order, and `done — N migration(s) applied`. The second
`db:status` says `up to date` and exits 0.
Every migration is additive (new tables, columns and indexes); none drops or rewrites data, and the mail
already stored stays readable (the rehearsal read back every message after migrating).
Run them from a checkout of the commit you will deploy (the go/no-go line), so the files match the code,
and **before** deploying it: the code reads what `0019` onwards add (0021–0022 hold the second factor; the
mailbox fails without 0021). Then check that the anon key cannot read
sign-in data:
`npm run cutover:check -- --region us` must show `ok anon is refused on public.session`. If it says this
login cannot switch to anon, check in the Supabase SQL editor instead:
`set role anon; select count(*) from public.session;` must fail with `permission denied`.

**Rollback:** not needed for additive migrations: the old page worker ignores these tables. Do not drop
anything by hand; if a migration itself is the problem, `docs/ops/migrations.md` has the per-file undo.

## 3. Preflight (5 min)

`cutover:check` runs this as its first part; if you ran it after storing the secrets, this is the same
check again. With the deploy's settings exported in your shell (the same values you just stored; they are never printed):

```sh
npm run preflight -- --region us --selector <your DKIM selector>
npm run preflight -- --region ru --no-dns
```

**Expected:** `Nothing required is missing.` and exit 0. Before step 6 the DNS lines for SPF, DMARC and the
app host may still be MISSING; everything **else** must be ok. Warnings (`MAIL_AUTH_DNS` not live yet,
`MAIL_LEGAL_RU_REVIEWED`) are expected now.
**Rollback:** none; fix what it lists and run it again.

## 4. Deploy US alongside the old site (10 min)

GitHub → Actions → **Deploy US (Cloudflare)** → `target: both`, confirmation `deploy us`.
`scripts/deploy-guard.mjs` refuses the old worker's name, routes, custom domains, Email Routing and R2, so
this cannot touch what users see.

**Expected:** the workflow is green. In Cloudflare, `cumulus-mail-inbound` and `cumulus-mail-api` exist
and `npx wrangler deployments list --name cumulus-mail-inbound` shows today's deploy.
**Rollback:** nothing user-facing changed. Leave them, or delete the two new workers.

## 5. Smoke the US deploy on its own URL (10 min)

```sh
npm run smoke -- --url https://cumulus-mail-api.<account>.workers.dev --region us
```

**Expected:** every line `ok` (`health` region us, schema current; `page`; `sign-in` to
`id.cumuluscloud.app` with PKCE; `security` CSP with a nonce, no grok.com, HSTS; `api-auth`). Then **sign
in once in a browser** through that URL, end to end.

Then the real-database inbound probe (`docs/deploy/cloudflare-handoff.md` §8, `MAIL_INBOUND_LIVE=1`):
expect it to store and then delete one encrypted test message.

**Rollback:** as step 4. **No-go** if any line fails: stop here; users have seen nothing.

## 6. Cutover: inbound, then the web host (15 min)

Follow `docs/deploy/cutover.md` Phases 1 and 2. In short:

1. Cloudflare → Email Routing → catch-all: `cumulus-mail` → **`cumulus-mail-inbound`**. Send yourself a
   message from an outside account; it arrives in the new app.
2. Workers → `cumulus-mail` → Domains: remove `mail.cumuluscloud.app`; `cumulus-mail-api` → Domains: add
   it. Back to back.
3. Set `BETTER_AUTH_URL` to `https://mail.cumuluscloud.app` (the `production-us` environment) and re-run
   the deploy for `api`.

```sh
npm run smoke -- --url https://mail.cumuluscloud.app --domain cumuluscloud.app
```

**Expected:** every line ok, including `mx` (Cloudflare Email Routing). Sign in, open the inbox, see the
message from 6.1.
**Rollback:** move the custom domain back to `cumulus-mail`, the catch-all back to `cumulus-mail`, and
`BETTER_AUTH_URL` back to the workers.dev origin. The old worker was never modified. Mail that arrived in
between stays in the new database.

4. Add the four rate-limiting rules in `docs/deploy/edge-rate-limits.md` (zone `cumuluscloud.app`), in
   **Log** mode for now. The smoke above stays all ok with them on.

## 7. Mail authentication DNS, then `MAIL_AUTH_DNS=live` (10 min + propagation)

Publish SPF, DKIM and DMARC exactly as in `docs/deploy/dns-records.md` (US #2–#4; the DKIM value from
`npm run dkim:record -- dkim.pem <selector> cumuluscloud.app`). Then:

```sh
npm run preflight -- --region us --selector <selector>      # SPF, DKIM (matching your key), DMARC now ok
```

When preflight shows them, set `MAIL_AUTH_DNS=live` on the inbound worker (Workers → `cumulus-mail-inbound`
→ Settings → Variables) and redeploy it. From then on, spoofed mail is quarantined and shared spam
reputation starts counting.

**Expected:** a message from a Gmail account arrives with `dmarc=pass` in the worker log
(`mail.inbound.auth`).
**Rollback:** unset `MAIL_AUTH_DNS` (mail is delivered without SPF/DKIM/DMARC checks again). Leave the DNS
records; they do no harm.

## 8. Deploy RU (10 min)

GitHub → Actions → **Deploy RU (Yandex Cloud)**, confirmation `deploy ru`. Then on the gateway's own domain:

```sh
npm run smoke -- --url https://<id>.apigw.yandexcloud.net --region ru
```

**Expected:** every line ok, region `ru`, sign-in through `ru.id.cumuluscloud.app`.
**Rollback:** roll the container back to its previous revision; users still reach the old page.

## 9. RU cutover and its scheduler (15 min)

1. `docs/deploy/cutover.md` Phase 3: the `ru.mail` record → the Yandex API Gateway, **DNS only, not
   proxied by Cloudflare**.
2. The Yandex timer trigger, every minute: `POST https://ru.mail.cumuluscloud.app/api/cron/tick` with
   `Authorization: Bearer <CRON_SECRET>`. **Without it, scheduled send, the outbound queue and the purge of
   deleted Russian mailboxes never run.** Check one call: it answers 200 with counts (`tenants`, `released`,
   `outbound`, `deletions`). **401** means the trigger sends the wrong secret. **404** means the container
   has no `CRON_SECRET`, or one shorter than 32 characters (the endpoint stays off); preflight for RU says
   which.
3. The client address the gateway passes on (sign-in rate limits are per address): in the container's
   request log, one request's `x-forwarded-for` should hold **one** address, the caller's. If it holds a
   chain (`client, gateway`), set `BETTER_AUTH_TRUSTED_PROXIES` to the gateway's ranges so the client hop is
   used; until then every chained request shares one sign-in bucket (safe, but one busy client could slow
   sign-in for the rest).

```sh
npm run smoke -- --url https://ru.mail.cumuluscloud.app
```

**Expected:** every line ok, including `ru-path` (no `cf-ray`, no `apigw-requestid`). The tester in Russia,
without a VPN, signs in and sees the inbox in Russian.
**Rollback:** restore the recorded DNS record (60 s TTL), and disable the timer trigger.

## 10. The first outside send (10 min)

With the SMTP relay configured (`docs/deploy/outbound-smtp.md`; `MAIL_SMTP_*`, `MAIL_DKIM_*`), send from a
Cumulus mailbox to an outside address you own (Gmail is a good test). Open "Show original" there.

**Expected:** `SPF: PASS`, `DKIM: PASS` with `d=cumuluscloud.app`, `DMARC: PASS`. It lands in the inbox, not
spam.
**Rollback:** unset `MAIL_SMTP_HOST`; outside mail waits in the Outbox again, nothing is lost.

## 11. Watch (rest of the day)

- `npm run smoke -- --url …` on both hosts every hour or two.
- Watch the alerts in `docs/ops/alerts.md`, especially **Inbound failing**, **Outbound bounces**, **CSP
  violations** and **Deletion overdue**.
- Leave the old worker `cumulus-mail` and its R2 bucket untouched for at least a week.
- Raise the DNS TTLs back tomorrow.
- Tomorrow, check Security → Events for the rate-limiting rules: if nothing legitimate was logged, switch
  them to **Block** (`docs/deploy/edge-rate-limits.md`).

---

## If something goes wrong after cutover

The full per-symptom playbook, with the alert for each and the kill switch for spam going out, is `docs/ops/incident.md`.

| Symptom | First move | Then |
|---|---|---|
| The site is down or erroring | Move the custom domain back to `cumulus-mail` (step 6 rollback) | Read `cumulus-mail-api` logs; fix; redeploy; smoke on workers.dev; move it again |
| Pages break because of the CSP | Set `MAIL_CSP=report-only` and redeploy `api` | `csp.violation` lines say what was blocked (`docs/deploy/csp.md`) |
| Mail stops arriving | Catch-all back to `cumulus-mail` | `mail.inbound.failed` lines carry the error class |
| Legitimate mail goes to Quarantine | Unset `MAIL_AUTH_DNS` | Check SPF/DKIM/DMARC with `npm run preflight` |
| Outside mail bounces | Unset `MAIL_SMTP_HOST` (mail waits in the Outbox) | Relay dashboard; `docs/deploy/dns-records.md` |
| `ru.mail` unreachable in Russia | Restore the old DNS record | Check it is DNS-only (no Cloudflare proxy) and the gateway certificate |

---

## Rollback and roll forward, for a bad deploy

Rolling back is always "run the last good build". No step here undoes a migration, and none needs to: the
previous build runs on the migrated database (the rehearsal rolled back and forward on it, both copies
smoke-green each time). Detail in `docs/ops/runbook.md` §4.

1. **Roll back.** US: Cloudflare → Workers → `cumulus-mail-api` (and/or `cumulus-mail-inbound`) →
   Deployments → the previous version → Rollback. RU: Yandex console → Serverless Containers → the
   container → Revisions → make the previous revision active.
2. **Check:** `/api/health` shows the previous `commit`, and
   `npm run smoke -- --url https://mail.cumuluscloud.app` (and the `ru.mail` one) is all ok.
3. **Roll forward** once the fix is on `main`: run the deploy workflow again (`deploy us` / `deploy ru`).
   Check `commit` and smoke the same way.
