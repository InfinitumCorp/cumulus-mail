# Cumulus://Mail

Local demo of the [Cumulus://Cloud](https://infinitum-corporation.vercel.app/products/cumulus-exchange) mail surface. The product page describes Drive, Mail, a shared 15 GB quota, and IMAP/SMTP on one Cumulus://ID. **This repository does not implement that.**

The inbox is sample data for `alex@cumuluscloud.app`, saved in the browser under `localStorage` key `cumulus-mail-v1`. Existing browser copies are not rewritten. Send does not leave the browser. “Inside” and “outbound” only mark whether an address host is exactly `cumuluscloud.app`. That match is not encryption, delivery, or tenant trust. There is no ciphertext, SMTP, IMAP, mailbox table, or Drive store. Attachments keep a file name and size. Calendar and contacts are sample lists. SCALVS briefs call the xAI API only when `XAI_API_KEY` is set on the server.

## Domain

Sample mailbox addresses use the base domain `cumuluscloud.app`. The sample persona is not an authenticated account.

These service hostnames are proposed names only. This repo does not verify their DNS, add them as trusted origins, or set them as a cookie domain:

- `id.cumuluscloud.app`
- `cloud.cumuluscloud.app`
- `mail.cumuluscloud.app`

Local development stays on `http://localhost:8080`, `http://127.0.0.1:8080`, and `http://[::1]:8080`. Session cookies stay host-only on this app’s own origin. Do not add a `*.cumuluscloud.app` origin. Cloud and Drive sign-in are not configured here.

```sh
# Proposed only. Not verified DNS. Not read by this app.
# CUMULUS_ID_ORIGIN=https://id.cumuluscloud.app
# CUMULUS_CLOUD_ORIGIN=https://cloud.cumuluscloud.app
# CUMULUS_MAIL_ORIGIN=https://mail.cumuluscloud.app
```

Do not treat a deploy of this app as delivered mail. A real mailbox needs persistent storage, an account that is not this sample persona, an authorized mail transport, DNS for the domain (MX, SPF, DKIM, DMARC), secrets outside the repo, and rate limits. `npm run build` applies `migrations/*.sql` when `DATABASE_URL` is set. There is no mail schema here, and none should be added until that design is reviewed. Google and Proton client repositories are not imported; their licenses do not provide a Cumulus mail backend.

## Run

```sh
npm install
npm run dev
```

Open the printed local address. The dev server listens on port 8080.

## Stack

TanStack Start, React 19, Tailwind 4. `npm run build` produces the Vercel output.
