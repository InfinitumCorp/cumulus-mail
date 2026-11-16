# Cumulus://Mail — operator runbook

For whoever is on call. Two copies of the app run independently:

| | **US** (everyone outside Russia) | **RU** (`ru.*` hosts) |
|---|---|---|
| Host | `mail.cumuluscloud.app` | `ru.mail.cumuluscloud.app` |
| Runs on | Cloudflare Workers `cumulus-mail-api` (app) and `cumulus-mail-inbound` (mail + per-minute cron), US placement | Yandex Cloud Serverless Container, `ru-central1`, **not** behind Cloudflare |
| Database | Supabase Postgres via Hyperdrive | Managed PostgreSQL in `ru-central1` (or the shared DB, decision D1) |
| Blobs | S3-compatible bucket | Yandex Object Storage `cumulus-mail-ru` |
| Secrets live in | GitHub environment `production-us` + Cloudflare worker secrets | Yandex Lockbox (`YC_LOCKBOX_ID`), attached at deploy |
| Deploy | `.github/workflows/deploy-cloudflare.yml`: manual, from `main` only, confirm `deploy us` | `.github/workflows/deploy-yandex.yml` → `deploy/yandex/deploy.sh`: manual, from `main` only, confirm `deploy ru` |
| Logs | Workers Logs / Logpush | Yandex Cloud Logging, log group stays in `ru-central1` |

Never deploy over, or delete, the old page worker **`cumulus-mail`** (`scripts/deploy-guard.mjs` refuses it).
The cutover itself is in `docs/deploy/cutover.md`; this page is for running what is live.

Items marked *(after #NN)* depend on a pull request that was open when this was written.

---

## 1. Incident checklist

Work down it; write the time next to each step in the incident note.

1. **Confirm and scope.** Which copy (US, RU, both)? What is broken: page, sign-in, sending, receiving?
   ```
   node scripts/smoke.mjs --host https://mail.cumuluscloud.app
   node scripts/smoke.mjs --host https://ru.mail.cumuluscloud.app
   curl -s https://mail.cumuluscloud.app/api/health?deep=1        # (deep: after #98, merged)
   ```
   `smoke --host` checks health, headers, the sign-in redirect and that `ru.*` is not served through AWS.
2. **Declare it** in the team channel: what, which copy, since when, who is on it. Update every 30 min.
3. **Stop the bleeding before diagnosing.** If a deploy in the last few hours lines up with the start,
   **roll back first** (section 4) and investigate after.
4. **Look at health and logs** (sections 2–3): `status`, `db`, `storage`, `schema.pending`, 5xx lines.
5. **Mail at risk?** Inbound mail that cannot be stored is retried by the sending server for days
   (temporary failure), so a short outage loses nothing. Outbound mail waits in the outbox queue and
   is retried by the scheduler. Check the queue before and after (`outbound_queue` row counts).
6. **Data or a secret exposed?** Go to section 6 for that secret, then section 7 (notification duties).
7. **Recover and verify:** `smoke --host` green on both hosts, a real sign-in, send and receive one
   message each way.
8. **Write it up within 2 working days:** timeline, cause, what stopped it, what changes so it cannot
   happen the same way.

---

## 2. Health

`GET /api/health` on each host. No secrets in it, cached 30 s, safe to poll.

| Field | Healthy | If not |
|---|---|---|
| `status` | `ok` (HTTP 200) | `degraded` (HTTP 503): one of the checks below failed |
| `region` | `us` on `mail.*`, `ru` on `ru.mail.*` | Wrong copy is answering: DNS or routing (cutover doc) |
| `commit` | the deployed commit | `unknown`: built without `APP_COMMIT`; check the deploy |
| `db.ok` | `true` | Database unreachable or timing out: section 5 |
| `storage.ok` | `true` | Bucket unreachable or credentials wrong |
| `schema.pending` *(after #91)* | `0` | A deploy is ahead of its schema: run the migrations (section 5) |
| `timings` (`?deep=1`) | db and storage in tens of ms | Slow, not broken: database or bucket latency |

Copies stand alone: RU being down does not affect US and the other way round.

---

## 3. Logs

`MAIL_REQUEST_LOG=on` writes one JSON line per request (`docs/deploy/logging.md`): method, scrubbed path,
status, duration, region, commit, request id. **No bodies, query strings, addresses or IPs** — so logs are
safe to share inside the team, and are not where to look for message content (there is none).

- **US:** Cloudflare dashboard → Workers → `cumulus-mail-api` / `cumulus-mail-inbound` → Logs, or the
  Logpush destination. The inbound worker logs `mail.schedule.ran` / `mail.schedule.failed` every minute.
- **RU:** `yc logging read --group-name cumulus-mail-ru --since 30m`. Filter `status >= 500`.
- **Match a user's report** to a line with the `id` (it is the `cf-ray` / API gateway request id when
  one was set).

---

## 4. Rollback

Rolling back is always "deploy the last good commit". Nothing in a deploy changes data, except migrations
(section 5), which are written to be backward compatible.

The deploy workflows **only run from `main`** and ask for a typed confirmation (`deploy us` /
`deploy ru`), so "deploy an old commit" means one of two things:

**Fastest: the platform's own rollback** (no build, seconds)
- **US:** Cloudflare dashboard → Workers → `cumulus-mail-api` (and/or `cumulus-mail-inbound`) →
  Deployments → roll back to the previous version. Cloudflare keeps recent versions.
- **RU:** Yandex console → Serverless Containers → the container → Revisions → make the previous revision
  the active one.
- Then verify: `/api/health` shows the previous `commit`; `smoke --host` green.
- **Afterwards make `main` match:** revert the bad change on `main` (a revert commit through a PR), and
  run the deploy workflow from `main` once it is green. Until then a routine deploy would bring the bad
  version back, so say in the incident note that `main` is ahead of what is live.

**Through GitHub** (when the platform rollback is not available)
1. Revert the bad commit on `main` with a PR (`git revert <sha>`), CI green.
2. Actions → *Deploy (Cloudflare)* → Run workflow → `target` `api`, `inbound` or `both`, confirm
  `deploy us` (the `production-us` environment requires a reviewer). For RU: *Deploy (Yandex)*, confirm
  `deploy ru`.
3. Verify as above.

**Cutover rollbacks** (moving a host back to the old page worker) are in `docs/deploy/cutover.md`, per phase.

---

## 5. Migrations

The schema is `migrations/*.sql`, applied in file-name order, each in one transaction and recorded in
`public._migrations`. Migrations only **add** (tables, columns, indexes); none drops or rewrites data, so
the previous app version keeps working against the new schema. That is what makes rollback safe.

**Before every deploy, per copy:**
```
DATABASE_URL=<that copy's database> npm run db:status    # lists pending files; exit 3 if any
DATABASE_URL=<that copy's database> npm run db:migrate   # applies them, one transaction each
DATABASE_URL=<that copy's database> npm run db:status    # exit 0: up to date
```
Then deploy from `main`. `/api/health` shows `schema.pending: 0` *(after #91)*.

- Run from a checkout of **the commit being deployed**, so the files match the code.
- US: the Supabase connection string (session pooler) from the Supabase dashboard; never commit it.
- RU: the Managed PostgreSQL string from Lockbox, from a machine that can reach `ru-central1`.
- A migration that fails rolls itself back (one transaction per file) and stops; nothing after it runs.
  Fix forward with a new migration file; never edit one that has been applied anywhere.
- Some migrations need a follow-up job, named in their PR: e.g. after `0011` (search, #84) run
  `scripts/reindex-words.mjs`.

---

## 6. Secret rotation

For each secret: where it lives, what rotating it does to people, and the steps. **Rotate one at a time**,
verify, then the next. After any suspected exposure, rotate first and investigate after — except
`MAIL_BLOB_KEY`, which has its own procedure (read its section).

### `BETTER_AUTH_SECRET` — signs sessions
- **US:** GitHub env `production-us` + worker secret. **RU:** Lockbox.
- **Effect:** every session becomes invalid; **everyone is signed out** and signs in again. No data lost.
- **Steps:** `openssl rand -base64 48` → set the new value in the secret store → redeploy (US: run the
  workflow; RU: deploy a new revision, which re-reads Lockbox) → `smoke --host`, sign in once.

### `MAIL_BLOB_KEY` — encrypts every blob and every sealed field ⚠
- **US:** GitHub env + worker secret. **RU:** Lockbox.
- **Never just change it.** One key seals all stored mail, attachments and encrypted fields
  (`src/lib/storage/crypto.ts`). Replacing it without the procedure below makes all existing mail
  unreadable.
- **Rotation (#114):** follow `docs/ops/key-rotation.md`.
  1. Add the new key as current in `MAIL_BLOB_KEYS` (`1:<new>,0:<old>`) and deploy.
  2. `npm run keys:rekey` (a dry run), then `npm run keys:rekey -- --apply`. It is resumable, and safe to
     re-run.
  3. Verify with another dry run.
  4. Remove the old key from the list and deploy.
  `MAIL_BLOB_KEY` itself stays set: it becomes the stable key for lookup hashes, which never rotate.
  **Until #114 is merged and deployed there is no rotation path**: treat the steps below as the only
  response.
- **If it is exposed:** an attacker also needs the database or the bucket to use it.
  1. Rotate the database and bucket credentials (below) immediately.
  2. Then rotate the key as above.
  3. Record in the incident note that the old key still lets someone test guesses against the lookup
     hashes.
- **Back it up**, and every key in `MAIL_BLOB_KEYS`, in the password manager the team uses for recovery
  keys. Keep a retired key for as long as backups sealed under it are kept. Losing the current key loses
  every mailbox.
- The US and RU copies have **separate** keys; never copy one to the other.

### `DATABASE_URL` / database password
- **US:** Supabase password → Hyperdrive config (`HYPERDRIVE_ID`); the API worker reaches the DB through
  Hyperdrive. **RU:** Lockbox `DATABASE_URL`.
- **Effect:** none for people if done in order.
- **Steps (US):** Supabase → reset the database password → update the Hyperdrive configuration with the new
  password → `/api/health` `db.ok`. Update anywhere `db:migrate` is run from.
- **Steps (RU):** create a second DB user with the same grants → put its string in Lockbox → deploy a new
  revision → check health → drop the old user.

### `MAIL_S3_ACCESS_KEY_ID` / `MAIL_S3_SECRET_ACCESS_KEY` — the bucket
- **US:** the S3-compatible provider's console + worker secrets. **RU:** Yandex static access key of the
  service account, in Lockbox.
- **Effect:** none if the new key is live before the old is revoked.
- **Steps:** create a **second** key → update the secret store → redeploy → `/api/health` `storage.ok` →
  **then** delete the old key.

### `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`
- **Where:** GitHub env `production-us` (+ worker secret); Lockbox for RU if billing runs there.
- **Effect:** none if done in order; a webhook signed with an old secret is refused while they differ.
- **Steps:** Stripe → Developers → API keys → roll the secret key (Stripe lets the old one live for a
  set time) → update → redeploy. Webhook: Developers → Webhooks → the endpoint → roll the signing secret
  → update `STRIPE_WEBHOOK_SECRET` → redeploy → send a test event, expect 200.

### `CRON_SECRET` — RU scheduler *(after #88)*
- **Where:** Lockbox, and the Yandex timer trigger that calls `POST /api/cron/tick`.
- **Effect:** scheduled sends and the outbound queue pause between the two updates (a minute or two).
- **Steps:** `openssl rand -hex 32` → Lockbox → new revision → update the trigger's header → watch the
  next tick log 200.

### `MAIL_SMTP_PASSWORD` — outbound relay (when SMTP is on)
- **Effect:** outbound mail waits in the queue while they differ; it is retried, not lost.
- **Steps:** create the new credential at the relay → update → redeploy → send one message out.

### `MAIL_DKIM_PRIVATE_KEY` — signs outgoing mail
- **Effect:** mail signed with a key whose public half is not in DNS fails DKIM. Rotate with a **new
  selector**, never in place.
- **Steps:** generate a new key pair → publish the public key at `<newselector>._domainkey.<domain>` →
  wait for DNS → set `MAIL_DKIM_SELECTOR` to the new selector and the new private key → redeploy → check a
  sent message's `DKIM-Signature: s=` and a receiver's "dkim=pass" → after a week remove the old record.

### Deploy credentials: `CLOUDFLARE_API_TOKEN`, `YC_SA_KEY_JSON`
- **Effect:** deploys fail until updated; the running app is unaffected.
- **Steps:** create a new token / service-account key with the same scopes → update the GitHub secret →
  run a deploy → revoke the old one.

---

## 7. Personal-data incidents

If personal data may have left the system (a leaked database dump, a bucket opened to the internet, a
secret above exposed together with the data it protects):

- **RU (152-ФЗ, ст. 21 ч. 3.1):** notify **Roskomnadzor within 24 hours** of finding out, and send the
  results of the investigation within 72 hours. Who files it is the operator named in the privacy policy
  (`docs/legal-ru.md` *(after #97)*).
- **EU users (GDPR art. 33):** the supervisory authority within **72 hours**, and the people affected
  without undue delay when the risk to them is high.
- Keep the incident note as the record: what, when found, what data, how many people, what was done.

This section is a checklist, not legal advice; the operator's lawyer confirms the wording of any notice.

---

## 8. Routine

| When | What |
|---|---|
| Every deploy | `db:status` / `db:migrate` per copy, deploy, `smoke --host` both hosts |
| Weekly | Check 5xx in both log streams; check the outbound queue is not growing |
| Monthly | `npm run blobs:sweep` (dry run) per copy *(after #105)*; review the report |
| Quarterly | Rotate `BETTER_AUTH_SECRET` and the S3 keys; restore a database backup into a scratch project and run `db:status` against it; `npm run drill:restore` (§9) |
| Yearly | DKIM key with a new selector |

## 9. Backup and restore

Mail is three things, and a restore needs all three:
1. **The database:** messages, sealed fields and the blind indexes.
2. **The blob store:** raw messages and attachments, sealed.
3. **The key(s):** `MAIL_BLOB_KEY`, plus every key in `MAIL_BLOB_KEYS` that sealed anything in the backup, plus `MAIL_BLIND_KEY` if set.

The keys are **not** in either backup. Keep them in the recovery password manager, and keep a retired key for as long as backups sealed under it exist. Without the keys, a backup is unreadable.

### What to back up, per copy
| | US (Cloudflare) | Russia (Yandex) |
|---|---|---|
| Database | Supabase Postgres: daily backups, plus PITR if the plan has it | Managed PostgreSQL in `ru-central1`: automatic daily backups (set the retention), plus PITR |
| Blobs | Supabase Storage bucket `cumulus-mail`: a scheduled copy to a second bucket (`rclone sync` or the provider's replication) | Object Storage bucket `cumulus-mail-ru`: versioning on, plus a scheduled copy to a second bucket in `ru-central1` |
| Keys | password manager (US keys) | password manager (RU keys, never the US ones) |

Back up the blobs **after** the database dump is taken, never before. A blob newer than the dump is harmless (unreferenced). A row that points at a blob the copy missed is a lost attachment.

### RPO / RTO
**RPO** (how much mail a restore can lose): up to the age of the newest backup.
- Daily dumps alone: up to 24 h.
- With PITR: minutes.

Inbound mail that arrives during an outage is retried by the sending servers for days. So the window for losing *inbound* mail is small even with daily dumps, **if the restore happens within that retry window**.

**RTO** (time to readable mail), measured in the drill (2026-11-13, one sandbox machine, Postgres 16):
- 72,270 messages: a 322 MB dump in 2.6 s, restored into an empty database in 5.8 s (about 12,000 messages/s);
- the blob copy runs at the store's bandwidth.

Rough RTO for a copy: provisioning the new database and bucket (minutes) + restore (seconds per 10⁵ messages) + blob copy (bytes ÷ bandwidth) + redeploying with `DATABASE_URL` and the storage settings pointed at the restore.

### The drill: `npm run drill:restore`
Run it quarterly (§8), and after any change to storage or keys.

```sh
createdb drill_src && createdb drill_dst          # both throwaway
DATABASE_URL=postgres://…/drill_src node scripts/migrate.mjs
SOURCE_DATABASE_URL=postgres://…/drill_src TARGET_DATABASE_URL=postgres://…/drill_dst \
  npm run drill:restore -- --storage s3 --s3-endpoint <a scratch S3 endpoint>   # or --storage fs
```

What it does:
1. Seeds a drill mailbox through the app's own code: sealed fields, a raw message and an attachment. One message is sealed under `MAIL_BLOB_KEY`, one under a two-key `MAIL_BLOB_KEYS` ring.
2. Runs `pg_dump` → `psql` into the empty target.
3. Copies the referenced blobs **as ciphertext**.
4. Opens the mail from the target only: subjects decrypt, and the raw message and attachment match byte for byte.
5. Checks that the message sealed under the old key does **not** open once that key is dropped.

It refuses a target that isn't empty.

**Result on 2026-11-13: PASS** for filesystem storage and for S3 (the US and Russia layouts are both Postgres + S3).

### Restoring a copy for real
1. Create a new database and bucket in the copy's own region. **Never restore Russian data outside Russia.**
2. Restore the dump: `psql -v ON_ERROR_STOP=1 "$NEW_DATABASE_URL" < dump.sql`, or use the provider's PITR restore into a new instance.
3. Copy the blobs back into the new bucket, unchanged.
4. Deploy with `DATABASE_URL` and the storage settings pointing at the new resources, with **the same keys**.
5. Check:
   - `npm run db:status`: 0 pending;
   - `node scripts/smoke.mjs --host …`: health `ok`;
   - sign in and open an old message with an attachment.

