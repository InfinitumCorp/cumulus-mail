# Cumulus://Mail

Private email for every [Cumulus://ID](https://infinitum-corporation.vercel.app/products/cumulus-exchange). One address like `alex@cumuluscloud.app`, shared storage with Cumulus Drive, encrypted at rest. Mail between Cumulus accounts is marked end-to-end. Nothing in the mailbox is scanned for ads.

This client is the web app: inbox, compose, drafts, calendar, contacts, and Architect tasks. SCALVS briefs and drafts run on open-weight models through OmniRoute (`OMNIROUTE_API_KEY`, `OMNIROUTE_URL` default `http://localhost:20128/v1`), switching automatically to Cloudflare Workers AI (`CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_AI_TOKEN`) or Groq (`GROQ_API_KEY`) when one fails or stalls. The mailbox is stored on the server. Metadata is in the `cumulus_mail` Postgres schema, and attachment bytes go through the storage adapter (`MAIL_STORAGE=local` by default, under `MAIL_BLOB_DIR` or `.data/mail-blobs`). The S3 driver uses AWS SDK v3 with the same `put` / `get` / `delete` / `probe` shape as the Drive driver. Subjects, addresses, snippets, headers, display names, signatures, and authentication results are encrypted in Postgres. An address is found by its domain, then by an HMAC under that tenant's key. Mail between local Cumulus addresses is delivered inside the app. This preview does not send to external addresses.

Addresses default to `@cumuluscloud.app`. The app host defaults to `mail.cumuluscloud.app`. Override either with `MAIL_DOMAIN` and `MAIL_APP_HOST` (or `VITE_MAIL_DOMAIN` and `VITE_MAIL_APP_HOST` in the browser). Blob encryption uses `MAIL_BLOB_KEY` (32 bytes, hex or base64). People sign in with Google (see below). Cross-app bearer tokens are off unless `CUMULUS_OIDC_ISSUER` names an OIDC issuer to trust, with `CUMULUS_OIDC_JWKS_URL` as an optional key-set override; there is no Amazon Cognito default. `npm run build:inbound` writes `dist/inbound/index.js` and `dist/inbound/metadata.json` for a Cloudflare Workers script upload. DNS templates for that Cloudflare zone live in `docs/dns/`. The inbound worker config lives in `workers/email/wrangler.jsonc` (worker name `cumulus-mail-inbound`) and is not deployed by this repository. `npm run build` stays on the Vercel preset. `npm run build:workers` builds the API for Cloudflare with Nitro preset `cloudflare-module` as worker `cumulus-mail-api` on workers.dev, with no route on `mail.cumuluscloud.app`. Inbound SPF, DKIM, and DMARC use a fixture resolver unless `MAIL_AUTH_DNS=live`. Deploy steps are in `docs/deploy/cloudflare-handoff.md`.

## Sign in

People sign in with Google only: one "Sign in with Google" button, which runs Better Auth's Google provider (authorization code + PKCE) and brings the person back signed in. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (the secret goes in the platform's secret store, never in this repository) and register `<BETTER_AUTH_URL>/api/auth/callback/google` as a redirect URI on the Google OAuth client. Sign-in stays off until both are set. There is no local password, passcode or PIN.

## Run

```sh
npm install
npm run dev
```

Open the printed local address. The dev server listens on port 8080.

### Without Google sign-in (local only)

To try the app on your machine without signing in, turn sign-in off and give it a throwaway encryption key:

```sh
export MAIL_BLOB_KEY=$(openssl rand -hex 32)   # 32 random bytes; a new one each time is fine
VITE_AUTH_ENABLED=false npm run dev
```

With sign-in off and no `DATABASE_URL`, every visitor is the same dev user and the mailbox lives in an
in-process PGLite database (sample mail included). The server refuses this mode when `DATABASE_URL` is
set, so it can never share one user across a real database. Without `MAIL_BLOB_KEY` the page shows
"MAIL_BLOB_KEY is not set" and nothing is saved. Never reuse a local key in production.

### Browser tests

`npm run test:e2e` starts the dev server in that local mode on a free port, runs the Playwright smoke tests in
`e2e/` (inbox, saving, keyboard shortcuts, folders, phone layout) in Chromium, and stops the server. Set
`E2E_CHROMIUM_PATH` to use a specific Chromium; `npx playwright install chromium` installs Playwright's own.

## Stack

TanStack Start, React 19, Tailwind 4. `npm run build` produces the Vercel output.
