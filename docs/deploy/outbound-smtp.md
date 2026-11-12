# Outbound SMTP

Cumulus Mail can hand mail for outside addresses to an SMTP relay. **It is off by default.** With no
`MAIL_SMTP_HOST` set, mail to outside addresses is held in the Outbox exactly as before, and nothing is
written to the outbound queue.

Nothing in this repository deploys this or holds credentials. Set the variables below on the host that
runs the app (and, for retries, on the worker that runs the scheduled job).

## Settings

| Variable | Required | Meaning |
| --- | --- | --- |
| `MAIL_SMTP_HOST` | yes | Relay host. Unset means outbound is off. |
| `MAIL_SMTP_PORT` | no | Default `587`. `465` implies implicit TLS. |
| `MAIL_SMTP_SECURITY` | no | `starttls` (default) or `tls`. Plain-text SMTP is not offered. A server that does not advertise STARTTLS is refused. |
| `MAIL_SMTP_USER` | no | Turns on `AUTH PLAIN`. |
| `MAIL_SMTP_PASSWORD` | with user | **Secret.** Set it with the platform's secret store (`wrangler secret put`, Vercel encrypted env). Never commit it. |
| `MAIL_SMTP_HELO` | no | Name sent in `EHLO`. Defaults to `MAIL_DOMAIN`. |
| `MAIL_DKIM_SELECTOR` | no | Turns on DKIM signing. `d=` is the sender's domain. |
| `MAIL_DKIM_KEY_PATH` | with selector (Node) | Path to the PEM private key. |
| `MAIL_DKIM_PRIVATE_KEY` | with selector (Workers) | **Secret.** PEM text, for hosts without a file system. `\n` escapes are accepted. |
| `MAIL_OUTBOUND_DEV` | no | `memory`: accept every message in memory and never send. For local development only. |

## DKIM

Signatures are `a=rsa-sha256; c=relaxed/relaxed` (RFC 6376) over From, To, Cc, Subject, Date,
Message-ID, the MIME headers, and the reply headers when present. To set it up:

1. Generate a key: `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out dkim.pem`
2. Publish the public key at `<selector>._domainkey.<domain>`:
   `v=DKIM1; k=rsa; p=<base64 of: openssl rsa -in dkim.pem -pubout -outform DER>`
3. Set `MAIL_DKIM_SELECTOR` and the key variable on the host.

Publishing the DNS record is a manual step. This repository does not change DNS.

## Queue, retries and bounces

- When a sent message has outside recipients and outbound is on, one row per recipient goes into
  `cumulus_mail.outbound_queue` (migration `0008`). The recipient, envelope sender and raw message are
  sealed with the tenant key. The Sent copy's delivery line reads "Queued for delivery by SMTP."
- Due rows for the sender are tried at the end of the save that queued them. The rest, including
  retries, are sent every minute by the inbound worker's scheduled job (`handleScheduled` in
  `workers/email/src/index.ts`), after it releases scheduled drafts. The worker reads the
  `MAIL_SMTP_*` / `MAIL_DKIM_*` settings from its own bindings: set the plain ones as `vars`, and
  `MAIL_SMTP_PASSWORD` / `MAIL_DKIM_PRIVATE_KEY` with `wrangler secret put`. With none set, the job
  skips the queue.
- **2xx** marks the row sent. **5xx** records a bounce through the same code that stores incoming DSNs
  (`recordBounce` in `src/lib/mail/dsn.ts`) and puts the address on the suppression list. **4xx** and
  connection errors retry with exponential backoff (1 min, doubling, capped at 6 h) up to 8 attempts.
  After that the row bounces with its 4.x.x status, and the address is *not* suppressed.
- The Sent copy's delivery line shows "Sent by SMTP", "Retrying after …" or "Bounced (…)".

## Not yet covered

- **Over 24 MB.** A message larger than 24 MB once encoded (most providers cap at 25 MB) stays held, and its delivery line says so. So does one whose attachment bytes cannot be read.
- **Password-protected mail** keeps the link-only path. It is not sent by SMTP.
- **No HTML part.** Messages are sent as UTF-8 `text/plain` with a base64 body. Attachments go as `multipart/mixed`, each base64 with an RFC 2231 file name.
- **One recipient per SMTP transaction.** This keeps per-recipient retry state simple.
- **Workers sockets.** The SMTP client takes a socket dialer. The built-in one uses `node:net` and
  `node:tls`. On Workers, a dialer around `cloudflare:sockets` `connect()` (with `startTls()`) would
  replace it; that dialer is not included here.
