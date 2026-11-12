# Cumulus://Mail

Private email for every [Cumulus://ID](https://infinitum-corporation.vercel.app/products/cumulus-exchange). One address like `alex@cumuluscloud.app`, shared storage with Cumulus Drive, encrypted at rest. Mail between Cumulus accounts is marked end-to-end. Nothing in the mailbox is scanned for ads.

This client is the web app: inbox, compose, drafts, calendar, contacts, and Architect tasks. SCALVS briefs and drafts run on open-weight models through OmniRoute (`OMNIROUTE_API_KEY`, `OMNIROUTE_URL` default `http://localhost:20128/v1`), switching automatically to Cloudflare Workers AI (`CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_AI_TOKEN`) or Groq (`GROQ_API_KEY`) when one fails or stalls. The mailbox is stored on the server. Metadata is in the `cumulus_mail` Postgres schema, and attachment bytes go through the storage adapter (`MAIL_STORAGE=local` by default, under `MAIL_BLOB_DIR` or `.data/mail-blobs`). The S3 driver uses AWS SDK v3 with the same `put` / `get` / `delete` / `probe` shape as the Drive driver. Subjects, addresses, snippets, headers, display names, signatures, and authentication results are encrypted in Postgres. An address is found by its domain, then by an HMAC under that tenant's key. Mail between local Cumulus addresses is delivered inside the app. This preview does not send to external addresses.

Addresses default to `@cumuluscloud.app`. The app host defaults to `mail.cumuluscloud.app`. Override either with `MAIL_DOMAIN` and `MAIL_APP_HOST` (or `VITE_MAIL_DOMAIN` and `VITE_MAIL_APP_HOST` in the browser). Blob encryption uses `MAIL_BLOB_KEY` (32 bytes, hex or base64). Cumulus://ID is its own OpenID Connect issuer, so bearer tokens are verified against `https://id.cumuluscloud.app/realms/cumulus` by default (ES256; discovery at `/.well-known/openid-configuration` under the issuer, JWKS at `/protocol/openid-connect/certs`). A Cumulus://ID access token (`typ: at+jwt`) must carry Mail's client id (`CID_CLIENT_ID`, default `cumulus-mail`) in `aud`, and its verified `sub` (the cid) is the tenant. Name any other OIDC issuer with `CUMULUS_OIDC_ISSUER`, and override the JWKS URL with `CUMULUS_OIDC_JWKS_URL`. An Amazon Cognito user pool is opt-in only: set `CUMULUS_COGNITO_USER_POOL_ID` (and `CUMULUS_COGNITO_REGION` when it is not the prefix of the pool id). No client secret is needed: Mail is a public client with PKCE. The account dialog lists Cumulus://ID sessions and publishes or looks up OpenPGP keys through the `/api/id/sessions` and `/api/id/keys` APIs on `CID_ISSUER` (default `https://id.cumuluscloud.app`). `npm run build:inbound` writes `dist/inbound/index.js` and `dist/inbound/metadata.json` for a Cloudflare Workers script upload. DNS templates for that Cloudflare zone live in `docs/dns/`. The inbound worker config lives in `workers/email/wrangler.jsonc` (worker name `cumulus-mail-inbound`) and is not deployed by this repository. `npm run build` stays on the Vercel preset. `npm run build:workers` builds the API for Cloudflare with Nitro preset `cloudflare-module` as worker `cumulus-mail-api` on workers.dev, with no route on `mail.cumuluscloud.app`. Inbound SPF, DKIM, and DMARC use a fixture resolver unless `MAIL_AUTH_DNS=live`. Deploy steps are in `docs/deploy/cloudflare-handoff.md`.

## Sign in

People sign in with Cumulus ID only: "Sign in with Cumulus ID", or "Create a Cumulus ID" for people without one, both on the same screen. Each runs OAuth 2.0 authorization code + PKCE against `https://id.cumuluscloud.app` (`/api/id/authorize`, `/api/id/token`) as the public client `cumulus-mail`, and the person comes back signed in. There is no local password, passcode or PIN. Set `CID_ISSUER` to a mirror (for example one that loads in Russia without a VPN) and `CID_CLIENT_ID` to override the client. Cumulus ID returns codes only to origins registered for the client in nexus (`mail.cumuluscloud.app`, `ru.mail.cumuluscloud.app`).

## Run

```sh
npm install
npm run dev
```

Open the printed local address. The dev server listens on port 8080.

## Stack

TanStack Start, React 19, Tailwind 4. `npm run build` produces the Vercel output.
