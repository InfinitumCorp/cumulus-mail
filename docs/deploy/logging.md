# Request logs and health checks

## One JSON line per request

`MAIL_REQUEST_LOG=on` makes the server write one JSON object per request to stdout. It is **off by
default**: a deployment that has not asked for logs produces none.

```json
{"t":"2026-11-13T10:00:00.000Z","level":"info","msg":"request","id":"8f3c1d2e9b7a4c5d-DME",
 "method":"GET","path":"/api/health","status":200,"ms":13,"region":"ru","commit":"9cf6fc9"}
```

**What a line never contains**, by construction (`src/lib/observability/request-log.ts`):

- no request or response body;
- no query string — it is cut before the path is logged;
- no cookie, `Authorization` header or token;
- no email address — a segment containing `@` becomes `:addr`;
- no id that identifies a thing — `/p/<token>` becomes `/p/:id`, so a log cannot be used to open
  someone's protected message;
- **no client IP address.**

That last one is deliberate. An IP is personal data under 152-ФЗ, and a mail server's access log is
exactly where it leaks. Rate limiting needs the IP (see `BETTER_AUTH_IP_HEADERS`), but it is used and
dropped, never written. If the owner ever needs IPs for abuse handling, that is a decision to make
explicitly, with a retention period and a line in the privacy policy — not a default.

`id` is the inbound request id when the proxy set one (`cf-ray`, `x-request-id`, `x-amzn-trace-id`,
`apigw-requestid`), so a line can be matched with the proxy's own record. The header is caller
controlled, so only a short plain value is accepted; anything else is replaced with a fresh id.

## `/api/health?deep=1`

`/api/health` answers the usual report. `?deep=1` adds `timings`: milliseconds for the database check,
the storage check and the whole report, so a copy that is slow can be told from one that is broken.
Deep results are measured rather than served from the 30-second cache, and are cached separately, so a
plain call never receives them.

```json
{"status":"ok","region":"ru","db":{"ok":true,"ms":21},"storage":{"ok":true,"ms":4},
 "timings":{"db":21,"storage":4,"total":22}}
```

## Collecting them

### Russia — Yandex Cloud Logging

A Serverless Container writes its stdout to a log group automatically; nothing is needed in the image.

1. Create a log group in the same folder (`yc logging group create --name cumulus-mail-ru
   --retention-period 168h`). Pick the retention period with the privacy policy's retention section in
   mind: these lines contain no personal data, but the shorter the better.
2. Give the container's service account the `logging.writer` role.
3. Deploy with `MAIL_REQUEST_LOG=on` in `deploy/yandex/ru.env.example`.
4. Read them with `yc logging read --group-name cumulus-mail-ru --since 10m`, or in the console. The
   JSON fields are parsed, so filtering on `status >= 500` or on `id` works.

**The log group stays in `ru-central1`**, like the rest of the Russia copy. Do not forward these logs
to a collector outside Russia without checking the cross-border transfer section of the policy first.

### US — Cloudflare

Workers logs are sampled in the dashboard. For the full stream:

- **Workers Logpush** (needs a paid plan): enable `logpush = true` in `wrangler.jsonc` for
  `cumulus-mail-api` and create a Logpush job pointed at the owner's bucket. The JSON line appears in
  the job's `Logs` field.
- Or **Workers Trace Events** to a destination the owner already has.

Both are set up in the Cloudflare dashboard by the owner; the deploy workflow does not touch them.

## What is still missing

- No metrics or traces, only logs. If a dashboard is wanted, `/api/health?deep=1` is the thing to poll;
  it needs no credentials and returns no personal data.
- Nothing alerts yet. An alert on `status >= 500` in either collector is the first thing to add.
