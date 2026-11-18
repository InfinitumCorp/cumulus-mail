# Launch-day incidents: what to do first

One page per symptom: the alert that fires, the **first move** (a switch or a command, safe to do before you
understand the cause), how to check it worked, then where to dig. The general checklist (declare it,
update every 30 min, write it up) is `runbook.md` §1; this page is the per-symptom part.

**Rule:** if a deploy in the last few hours lines up with the start, **roll back first** (the last section)
and investigate after.

Scope it first, both copies:

```sh
node scripts/smoke.mjs --host https://mail.cumuluscloud.app
node scripts/smoke.mjs --host https://ru.mail.cumuluscloud.app
curl -s https://mail.cumuluscloud.app/api/health?deep=1      # status, region, commit, db, storage, schema
```

---

## Mail not arriving
**Alerts:** Inbound failing (`mail.inbound.result outcome=failed`), Inbound silent, DKIM verification broken.

1. **First move, if the new inbound worker is the cause:** in Cloudflare Email Routing, point the catch-all
   back at the previous worker (`friday.md` step 6 rollback). The sending servers retry temporary
   failures for days, so mail that got a 4xx is not lost.
2. **Check:** send one message from an outside account; a `mail.inbound.result outcome=stored` line appears
   within a minute.
3. **Dig:** `mail.inbound.failed` lines carry the error class.
   - Database or storage: `/api/health?deep=1` → `db.ok`, `storage.ok`.
   - MX records still point at Cloudflare: `npm run preflight -- --region us`.
   - Legitimate mail going to Quarantine instead: unset `MAIL_AUTH_DNS` on `cumulus-mail-inbound`; mail is
     delivered without SPF, DKIM or DMARC checks again.

## Mail not sending (outside)
**Alerts:** Outbound stuck (`oldestQueuedSeconds` > 1800 or `queued` > 500), Outbound bounces, Retries climbing.

1. **First move, if the relay is rejecting us** (`5.7.x` bounces, or a blocklist): unset `MAIL_SMTP_HOST`.
   Outside mail waits in the Outbox queue, and nothing is lost. Mail inside Cumulus is unaffected.
2. **Check:** `mail.outbound.result` lines stop; `mail.queue.depth` holds steady instead of climbing with
   bounces.
3. **Dig:**
   - The relay's dashboard: suspended? rate limited? (`retry` lines with `4.x.x`).
   - SPF, DKIM and DMARC still published: `npm run preflight -- --region us --selector <selector>`.
   - The Scheduler silent alert: without the scheduler the queue never drains.
4. **Back on:** set `MAIL_SMTP_HOST` again; the queue drains at the per-mailbox caps.

## Sign-in broken
**Alerts:** `auth.failure` lines climbing; people report it. The sign-in screen tells each person which kind
of failure they hit (rate limit, blocked pop-up, cancelled, offline, failed at Cumulus ID).

1. **Is it Cumulus ID?** `npm run cutover:check -- --region us` (the token-issuer line), or by hand:
   `curl -s https://id.cumuluscloud.app/realms/cumulus/.well-known/openid-configuration`.
   If that is down, there is no switch on our side. Mail keeps arriving, and signed-in sessions keep
   working for their lifetime. Post a status note and wait for Cumulus ID.
2. **Is it us?** A deploy that changed `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET` or `CUMULUS_OIDC_ISSUER`:
   roll back (below). A rotated `BETTER_AUTH_SECRET` signs everyone out; that is expected.
3. **Many people see "Too many sign-in attempts"?** The limit is 10 sign-in starts per minute per IP. Behind
   the Yandex gateway every request can look like one address: check `x-forwarded-for`
   (`friday.md` step 9) and set `BETTER_AUTH_TRUSTED_PROXIES`.
4. **Someone lost access to their Cumulus ID:** recovery happens at Cumulus ID, not here. Their mailbox is
   untouched and opens again when they sign in with the recovered ID. Do not create a second mailbox for
   them.

## Database down
**Alerts:** health `db.ok=false` (HTTP 503), Scheduler failing, Inbound failing.

1. **First move:** deploy with `MAIL_MAINTENANCE=1`. People see the "being updated" page (English and
   Russian, 503 with `Retry-After`) instead of errors. Health, CSP reports and the cron tick still answer.
2. Inbound mail gets a temporary failure and the sending servers retry it, so nothing is lost while the
   database is down. Scheduled sends wait.
3. **Dig:** the Supabase status page and dashboard (connections, CPU, disk). For the RU copy, the Yandex
   Managed PostgreSQL console. A restore is `runbook.md` §9.
4. **Back:** unset `MAIL_MAINTENANCE`, redeploy, `smoke --host` on both hosts.

## Spam wave going out
**Alerts:** Outbound spike, Sign-up wave (`mail.outbound.held reason=new_accounts_busy`, once that cap is on), any
`mail.outbound.paused by=auto`, Outbound bounces with `5.7.x`.

1. **First move: pause the mailboxes doing it.** This stops all their outside sending, including mail
   already queued:
   ```sh
   npm run outbound:pause -- --list                                   # who is paused already
   npm run outbound:pause -- --address <mailbox> --hours 72 --reason "Under review: unusual sending"
   ```
   Run it with that region's `DATABASE_URL` and `MAIL_BLIND_KEY` exported.
2. **Everything at once (the reputation is at stake):** unset `MAIL_SMTP_HOST`. All outside mail waits in
   the queue.
3. **Tighten for everyone without a deploy of code:**
   - `MAIL_OUTBOUND_NEW_ACCOUNTS_HOURLY`: all mailboxes under a week old, together, per hour; off until set
     (for example 300). In launch week every mailbox is under a week old: set it high enough for real use.
   - `MAIL_OUTBOUND_HOURLY_LIMIT` and `MAIL_OUTBOUND_DAILY_LIMIT`: per mailbox; default 100 and 500.
   - `MAIL_OUTBOUND_MAX_RECIPIENTS`: distinct outside addresses per message; default 50.
4. **After:** check blocklists for the sending IP and domain, and the DMARC aggregate reports. Resume a
   mailbox that was not abusive with `npm run outbound:pause -- --address <mailbox> --resume`.

## Spam wave coming in
**Alerts:** Spoofing wave (`dmarc=fail` > 30 %, or quarantine > 3× baseline).

1. With `MAIL_AUTH_DNS=live`, mail failing DMARC already goes to Quarantine, and shared reputation counts
   people's spam votes.
2. **First move for one bad sending domain or address:** a Cloudflare Email Routing rule that drops it
   (dashboard → Email Routing → Routing rules), or a rule in the WAF for the web side. Neither touches
   anyone's mail already stored.
3. **Dig:** `mail.inbound.auth` lines by `dmarc` and `disposition`; the quarantine folders of the mailboxes
   reporting it.

## Rollback
Always "deploy the last good commit"; full detail in `runbook.md` §4.
- **US, seconds:** Cloudflare → Workers → `cumulus-mail-api` / `cumulus-mail-inbound` → Deployments → roll
  back to the previous version.
- **RU:** Yandex console → Serverless Containers → the container → Revisions → make the previous one active.
- **Before the DNS cutover is settled:** move the custom domain and the Email Routing catch-all back to the
  previous worker (`friday.md` step 6 rollback).
- **Check:** `/api/health` shows the previous `commit`; `smoke --host` is green.
- **Then:** revert the change on `main` with a PR, so a routine deploy does not bring it back.
- Migrations are additive and need no rollback. `migrations.md` has the per-file undo if one is ever the
  problem.
