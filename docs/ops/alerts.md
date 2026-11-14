# Metrics and alerts

Both copies write one JSON line per event to stdout (`src/lib/observability/metrics.ts`), next to the request log. An alert is a count or ratio of lines over a window.

The lines never contain addresses, subjects or message ids; anything that looks like an address is replaced with `[redacted]`. Each line has `t`, `metric`, `region` (when `MAIL_REGION` is set) and the fields below.

| `metric` | Fields | Where it comes from |
|---|---|---|
| `mail.outbound.result` | `outcome`: `sent` / `retry` / `bounced`; `status` (SMTP enhanced, e.g. `5.1.1`); `permanent`; `attempts` | each recipient attempt in the outbound queue |
| `mail.queue.depth` | `queued`, `sending`, `oldestQueuedSeconds` | every scheduled run (US: the inbound worker's cron; Russia: the scheduler tick, #88) |
| `mail.inbound.result` | `outcome`: `stored` (`folder`: `mailbox` / `quarantine`) / `duplicate` / `rejected` (`reason`) / `no_mailbox` / `other_domain` / `failed` | every inbound message |
| `mail.inbound.auth` | `spf`, `dkim`, `dmarc` (`pass` / `fail` / `none` / …), `disposition` | every inbound message that reaches a mailbox |
| `auth.failure` | `reason`: `no_session` / `cross_site` / `tenant_mismatch` | a refused authenticated call |
| request log (`msg: "request"`) | `status`, `ms`, `path` (scrubbed) | every request, when `MAIL_REQUEST_LOG=on` |

## Alerts and thresholds
The thresholds are starting points. Set them from the first two weeks of real traffic.

| Alert | Rule (5-minute window unless stated) | Severity | First look |
|---|---|---|---|
| **Outbound bounces** | `bounced` ÷ (`sent` + `bounced`) > **5 %** with ≥ 20 attempts; or any `status` starting `5.7.` (policy/reputation) > 3 in 15 min | page | relay dashboard, `docs/deploy/dns-records.md` (SPF/DKIM still published?) |
| **Outbound stuck** | `mail.queue.depth.oldestQueuedSeconds` > **1800** on two runs in a row, or `queued` > **500** | page | relay reachable? `MAIL_SMTP_*` settings? `retry` lines and their `status` |
| **Retries climbing** | `retry` > **25 %** of attempts over 30 min | ticket | relay rate limits (4.x.x) |
| **Inbound failing** | `mail.inbound.result.outcome = failed` > **0** in 5 min, or more than 10 in an hour | page | worker logs: `mail.inbound.failed` carries the error class |
| **Inbound silent** | no `mail.inbound.result` lines for **60 min** in working hours (once there is steady traffic) | ticket | MX records, Email Routing catch-all → `cumulus-mail-inbound` |
| **Mailboxes full** | `rejected` with `reason=mailbox_full` > 20 per hour | ticket | storage enforcement (`MAIL_ENFORCE_STORAGE`), plans |
| **Spoofing wave** | `mail.inbound.auth` with `dmarc=fail` > **30 %** of inbound over 30 min with ≥ 50 messages, or `disposition=quarantine` > 3× its daily baseline | ticket | quarantine folder of affected mailboxes |
| **DKIM verification broken** | `dkim=fail` > **50 %** of inbound with ≥ 50 messages (senders don't all break at once; a bug or a DNS resolver problem does) | page | `MAIL_AUTH_DNS`, resolver reachability |
| **Auth failures** | `auth.failure` with `reason=cross_site` > **20** in 5 min (an attack, or a broken proxy setting); `tenant_mismatch` > **0** (should never happen); `no_session` > 10× baseline | page for `tenant_mismatch`, ticket otherwise | request log for the paths |
| **Errors** | request log `status` ≥ 500 > **2 %** of requests with ≥ 100 requests | page | `/api/health`, then logs |
| **Health** | `GET /api/health` not 200 for 3 checks in a row (external check every minute) | page | runbook §2 |

## Wiring it up (no account changes are made by this repository)
### US: Cloudflare
1. Workers Logs (`observability.enabled`) already keeps the lines for both workers. Query them in the dashboard (Workers → Logs) with filters such as `metric = "mail.outbound.result" AND outcome = "bounced"`.
2. For alerts, add **Logpush** for both workers (`cumulus-mail-api`, `cumulus-mail-inbound`) to the log tool the team uses (Datadog, Grafana Loki, Better Stack…). Build the rules above there.
3. For the health alert, use **Cloudflare Health Checks** or any external uptime check on `https://mail.cumuluscloud.app/api/health`.

### Russia: Yandex Cloud
1. Serverless Container stdout goes to **Cloud Logging** (the container's default log group). The JSON lines are parsed, so filter on `json_payload.metric = "mail.outbound.result"`.
2. In **Monitoring**, make a log-based metric per alert (count with a filter), then an **alert** on it with the threshold above. Use a notification channel to the on-call email or Telegram.
3. Health: a Monitoring HTTP check on `https://ru.mail.cumuluscloud.app/api/health`.

Keep the Russian copy's logs in Russia: send them to a log group or tool in `ru-central1`, not to the US tooling.
