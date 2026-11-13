# Cutover: from the old page worker to the new app

This is the plan for moving `mail.cumuluscloud.app` (US) and `ru.mail.cumuluscloud.app` (RU) from today's
static page to this app, step by step, with a way back at every step. Each switch is an owner action in a
dashboard (Cloudflare, Yandex Cloud, DNS). The repository and its workflows never make these changes.

## Where things stand (checked 2026-11-12)

| | Today | Target |
|---|---|---|
| `mail.cumuluscloud.app` | Cloudflare worker **`cumulus-mail`** (custom domain), a static page with `cumulus-config.js`; its own email handler and R2 bucket `cumulus-mail-files` | Worker **`cumulus-mail-api`** (this app, `npm run build:workers`), US placement |
| `ru.mail.cumuluscloud.app` | The same static page, reached **through Cloudflare and then AWS API Gateway** (`cf-ray`, `apigw-requestid`) | This app as a **Yandex Cloud** Serverless Container in `ru-central1`, not behind Cloudflare or AWS |
| Inbound mail (`@cumuluscloud.app`) | Email Routing catch-all → worker `cumulus-mail` | Catch-all → **`cumulus-mail-inbound`** |
| `/api/health` | 404 on both hosts | 200 with the region and commit (#78); `schema.pending` 0, else apply the migrations first |
| Production database (Supabase) | Migrations `0006`–`0010` applied; the mail tables are **empty** | Same database for the US copy; `DATABASE_URL=… npm run db:status` lists pending migrations (exit 3) without applying them, `npm run db:migrate` applies them; the RU database depends on decision D1 (`docs/deploy/yandex-ru.md`) |

`node scripts/smoke.mjs --host https://<host>` (#82) reports all of this for a host and is the go/no-go check
at every step below.

## Decisions before starting

1. **Data in the old worker.** If `cumulus-mail` stored real mail (its email handler, R2 `cumulus-mail-files`),
   decide whether to import it into the new app or start empty. The new app's tables are empty today. Nothing
   below deletes the old worker or its bucket.
2. **RU decisions** D1–D6 in `docs/deploy/yandex-ru.md` (data residency, inbound for Russian mailboxes,
   scheduler, container vs VM, the Cumulus ID mirror).
3. **A window.** Pick a quiet hour. DNS steps need the record's TTL lowered to 60 s at least one old-TTL
   period beforehand.

## Phase 0: deploy alongside, change nothing users see

1. Deploy `cumulus-mail-inbound` and `cumulus-mail-api` (Actions → *Deploy US (Cloudflare)*, #80). Both are
   on their own names; `scripts/deploy-guard.mjs` refuses `cumulus-mail`, routes, custom domains, Email
   Routing and R2. Nothing user-facing changes.
2. Check the API worker on its own URL:
   `node scripts/smoke.mjs --host https://cumulus-mail-api.<account>.workers.dev`
   expects `health`, `page` and `sign-in` ok (`region us`). Sign in once through it end to end.
3. Deploy the RU container (Actions → *Deploy RU (Yandex Cloud)*, #81) and check it on its API Gateway's
   default domain: `node scripts/smoke.mjs --host https://<id>.apigw.yandexcloud.net --region ru`
   (`MAIL_REGION=ru` makes it report region `ru` and sign in through the mirror).
4. Run the handoff's real-database inbound probe (`docs/deploy/cloudflare-handoff.md`, section 8).

**Rollback:** nothing to roll back; the old worker still serves both hosts. Delete the new workers or
container revision if wanted.

## Phase 1: inbound mail (US)

Only after Phase 0 step 4 passes (the handoff's section 6 / step 6 test):

1. Cloudflare dashboard → zone `cumuluscloud.app` → Email Routing → catch-all: worker `cumulus-mail` →
   `cumulus-mail-inbound`. No MX or DNS change.
2. Send one message to a mailbox that exists in the new app. Confirm the worker log `mail.inbound.stored`, an
   encrypted `cumulus_mail.messages` row, and a ciphertext object under `tenants/<tenantId>/`.

**Rollback:** set the catch-all back to `cumulus-mail` (one dashboard change, immediate).
Mail that arrived in between stays in the new app's database.

## Phase 2: `mail.cumuluscloud.app` → the new app (US)

1. Note the current setting: `mail.cumuluscloud.app` is a **custom domain of worker `cumulus-mail`**.
2. In Workers → `cumulus-mail` → Settings → Domains & Routes, remove `mail.cumuluscloud.app`; then in
   `cumulus-mail-api` → Domains & Routes, add it as a custom domain. Do this back to back: in between, the
   host answers with an error. (Do not put the domain in `workers/api/wrangler.jsonc`: the deploy guard
   refuses it, on purpose, so the binding stays a deliberate dashboard action.)
3. Set the API worker's `BETTER_AUTH_URL` secret to `https://mail.cumuluscloud.app` (it was the workers.dev
   origin) and make sure nexus lists that origin for `cumulus-mail` (it already does).
4. `node scripts/smoke.mjs --host https://mail.cumuluscloud.app` → all ok, region `us`. Sign in end to end.

**Rollback:** move the custom domain back from `cumulus-mail-api` to `cumulus-mail` (and `BETTER_AUTH_URL`
back to the workers.dev origin). The old worker was never modified, so it serves exactly as before.

## Phase 3: `ru.mail.cumuluscloud.app` → Yandex Cloud (RU)

1. Lower the TTL of the `ru.mail` record to 60 s, one old-TTL period ahead. Record the current record
   (today it routes through Cloudflare to AWS API Gateway) so it can be restored exactly.
2. Attach the `ru.mail.cumuluscloud.app` certificate (Certificate Manager) and domain to the Yandex API
   Gateway in front of the container.
3. Change the DNS record to the Yandex API Gateway's domain, **DNS only (not proxied by Cloudflare)**, so
   Russian users reach Yandex directly.
4. `node scripts/smoke.mjs --host https://ru.mail.cumuluscloud.app` → `ru-path` ok (no `cf-ray`, no
   `apigw-requestid`), `health` region `ru`, `sign-in` through `ru.id.cumuluscloud.app`. Test from a network
   in Russia without a VPN.

**Rollback:** restore the recorded DNS record (back through Cloudflare/AWS to the old page). With the 60 s
TTL this takes effect within minutes.

## Afterwards

- Keep the old worker `cumulus-mail` and its R2 bucket untouched for at least a week; delete only after the
  data decision (1) is carried out and nothing points at it (`smoke --host` on both hosts shows the new app).
- Raise the TTLs back.
- Turn on HSTS on both hosts once stable (the smoke check warns while it is missing).
