# Launch day: the ordered sequence (about 2 hours)

One page to follow on launch day, top to bottom. Every step has the command, what you should see, and how
to undo it. The details behind each step are in the docs linked from it; this page does not replace them,
it puts them in order.

**Who:** the owner, holding the Cloudflare, Yandex Cloud, Supabase and DNS logins. **Nothing in this
repository or its CI makes these changes**; every switch below is yours.

**Needs on `main`:** `npm run preflight` (#144, merged), and the launch PRs:
- #149, the post-deploy smoke (`npm run smoke -- --url`);
- #147, the deletion purge on both copies;
- #146, the spam reputation fix;
- #148, the security re-check;
- #150, the error and maintenance pages;
- the save fix that keeps new mail (see #86).

#86 lists the merge order.

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
- [ ] The Cumulus://ID cut-over is planned before step 5 (see step 5), or you accept doing the first end-to-end
      sign-in after step 6.

---

## 0. Freeze and note the starting point (5 min)

```sh
git fetch origin && git checkout origin/main && git log -1 --oneline   # the commit from the go/no-go list
npm ci
```

Optional: deploy with `MAIL_MAINTENANCE=1` to show a "being updated" page (English and Russian, 503 with
`Retry-After`) for the window. Health checks, CSP reports and the cron tick keep working, so steps 5–9 can
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

US (Supabase; the connection string from the Supabase dashboard, port 5432, `sslmode=require`):

```sh
export DATABASE_URL="postgresql://…:5432/postgres?sslmode=require"
npm run db:status        # lists what is pending; exit 3 if anything is
npm run db:migrate       # applies them in name order, each recorded in public._migrations
npm run db:status        # expect: nothing pending, exit 0
```

RU: the same three commands with the RU database's `DATABASE_URL` (if D1 gave Russia its own database).

**Expected:** the second `db:status` exits 0. Every migration is additive (new tables, columns and
indexes); none drops or rewrites data.
**Rollback:** not needed for additive migrations: the old page worker ignores these tables. Do not drop
anything by hand.

## 3. Preflight (5 min)

With the deploy's settings exported in your shell (the same values you just stored; they are never printed):

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

The issuer only sends people back to addresses it knows, and neither the old one nor the new one knows the
workers.dev address by default: the smoke's `sign-in` line checks the redirect Mail builds, not that the issuer
accepts it. So the new Cumulus://ID goes live **before this step**, started with
`CID_EXTRA_ORIGINS=cumulus-mail=https://cumulus-mail-api.<account>.workers.dev` (InfinitumCorp/cumulus-id,
`docs/deploy-checklist.md`, "Same day as the Cumulus://Mail launch"). Without it this sign-in ends on an
"invalid redirect" page at id.cumuluscloud.app: that is not a Mail fault; do the end-to-end sign-in after step 6
instead.

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
   deleted Russian mailboxes never run.** Check one call: it answers 200 with counts (`released`,
   `deletions`), not 401 or 404.

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

| Symptom | First move | Then |
|---|---|---|
| The site is down or erroring | Move the custom domain back to `cumulus-mail` (step 6 rollback) | Read `cumulus-mail-api` logs; fix; redeploy; smoke on workers.dev; move it again |
| Pages break because of the CSP | Set `MAIL_CSP=report-only` and redeploy `api` | `csp.violation` lines say what was blocked (`docs/deploy/csp.md`) |
| Mail stops arriving | Catch-all back to `cumulus-mail` | `mail.inbound.failed` lines carry the error class |
| Legitimate mail goes to Quarantine | Unset `MAIL_AUTH_DNS` | Check SPF/DKIM/DMARC with `npm run preflight` |
| Outside mail bounces | Unset `MAIL_SMTP_HOST` (mail waits in the Outbox) | Relay dashboard; `docs/deploy/dns-records.md` |
| `ru.mail` unreachable in Russia | Restore the old DNS record | Check it is DNS-only (no Cloudflare proxy) and the gateway certificate |
