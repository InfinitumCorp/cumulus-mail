# Launch checklist (owner actions)

Everything below is something only the owner can do: keys, accounts, DNS and decisions. The code for each
item is in the PR named; nothing here is done by the repository, and nothing is on until it is set. Secrets
go in the platform's secret store (`wrangler secret put`, Vercel encrypted env), never in this repository.

## 1. Sign-in: pick one path

Both paths are ready. Each has its own combined draft PR, so the choice is which one to merge.

| | Keep Cumulus ID | Google only |
|---|---|---|
| Combined PR | #70 | #46 |
| PRs | everything except #63 and #67 | everything, including #63 and #67 |

Both paths need `BETTER_AUTH_SECRET` (random, 32+ bytes, secret) and `BETTER_AUTH_URL` (this app's public origin).

### Path A: keep Cumulus ID (nothing to change in code)

- [ ] Cumulus ID (`https://id.cumuluscloud.app`) lists this app's origins for the public client `cumulus-mail`
      in nexus (`mail.cumuluscloud.app`, `ru.mail.cumuluscloud.app`, and any other host that serves the app).
      Cumulus ID returns codes only to those origins.
- [ ] Optional: `CID_ISSUER` (a mirror, for example one that loads in Russia without a VPN) and `CID_CLIENT_ID`.
      Neither is a secret; the flow is a public client with PKCE.
- [ ] Bearer tokens from other Cumulus apps are verified against the Cumulus://ID Amazon Cognito user pool
      by default. To use another pool or issuer, set `CUMULUS_COGNITO_USER_POOL_ID` (and
      `CUMULUS_COGNITO_REGION`) or `CUMULUS_OIDC_ISSUER`.

### Path B: Google only (PR #63, #67)

- [ ] Google Cloud console → APIs & Services → Credentials → OAuth client, type **Web application**.
- [ ] Authorized redirect URI: `<BETTER_AUTH_URL>/api/auth/callback/google` (one per host that serves the app).
- [ ] Secrets: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. Sign-in stays off until both are set.
- [ ] Decide what existing users need to know. Someone whose Google email matches their old account email is
      linked to it and keeps their mailbox. Anyone else starts with a new, empty mailbox.

New mailboxes get `<google username>@<MAIL_DOMAIN>` (numbered if taken), never the Google address itself. The
account dialog lists signed-in devices with sign-out (#67). The Amazon Cognito token check is removed.

## 2. Billing: Stripe (PR #64, test mode first)

- [ ] Set the prices (docs/plans.md §2 still says "owner to set").
- [ ] Products **Plus**, **Pro**, **Business**, each with a monthly and yearly price, lookup keys
      `plus_monthly`, `plus_yearly`, `pro_monthly`, `pro_yearly`, `business_monthly`, `business_yearly`.
- [ ] Turn on the Customer Portal (plan changes, card updates, cancel, invoices).
- [ ] Webhook endpoint `<app origin>/api/billing/webhook` for `checkout.session.completed`,
      `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`,
      `invoice.payment_failed`.
- [ ] Secrets: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`. Optional `BILLING_RETURN_URL`.
- [ ] Test-mode run: upgrade with card `4242 4242 4242 4242`, check the plan changes in the account dialog;
      use `4000 0000 0000 0341` to see the "Payment failed" notice; cancel in the Portal and see Free limits.
- [ ] Switch to live keys only after that.

## 3. Plans and limits (PR #59, #65, #66, #68)

- [ ] **Grandfathering decision** (docs/plans.md §6): keep existing mailboxes on Plus for free, or tell them
      ahead and move them to Free. Existing mailboxes are on Plus today and nothing moves them.
- [ ] `MAIL_DEFAULT_PLAN=free` when new sign-ups should start on Free. Unset keeps Plus.
- [ ] `MAIL_ENFORCE_STORAGE=1` on the inbound worker when full mailboxes should bounce new mail
      (`552 5.2.2 Mailbox full`). Unset accepts mail as before. The sidebar already warns at 90% and 100%.

## 4. Outbound mail to the internet (PR #40, #47, #56, #57, #61, #45, #49)

Setup details: `docs/deploy/outbound-smtp.md`.

- [ ] An SMTP relay account. Secrets/vars: `MAIL_SMTP_HOST`, `MAIL_SMTP_PORT`, `MAIL_SMTP_SECURITY`,
      `MAIL_SMTP_USER`, `MAIL_SMTP_PASSWORD` (secret).
- [ ] DKIM key pair; publish the public key as `<selector>._domainkey.<MAIL_DOMAIN>` (DNS change, owner only);
      set `MAIL_DKIM_SELECTOR` and `MAIL_DKIM_PRIVATE_KEY` (secret) or `MAIL_DKIM_KEY_PATH`.
- [ ] SPF and DMARC records that include the relay (templates in `docs/dns/`).
- [ ] Optional rate limits: `MAIL_OUTBOUND_HOURLY_LIMIT` (default 100), `MAIL_OUTBOUND_DAILY_LIMIT` (default 500).

Without `MAIL_SMTP_HOST`, outside mail stays held in the Outbox as it does today.

## 5. Infrastructure already described elsewhere

- [ ] Cloudflare: Hyperdrive id, inbound worker, optional API worker → `docs/deploy/cloudflare-handoff.md`.
- [ ] Storage bucket credentials and `MAIL_BLOB_KEY` (32 random bytes; never reuse a local key).
- [ ] Migrations in order (`0001`–`0010` once all PRs are in); `node scripts/smoke.mjs` afterwards.

## 6. Merge order

Each PR passes the full pipeline on its own. Stacked PRs retarget to `main` once their base merges.

- **Path A, keep Cumulus ID:** #69, #59, #64, #65, #66, #68, #62, #41, #60, #42, #43, #48, #37, #58, #40,
  #47, #56, #57, #61, #45, #49. Skip #63 and #67. Or merge #70 in one go.
- **Path B, Google only:** the same, plus #63 then #67 after #66. Or merge #46 in one go.

## 7. Before turning things on

- [ ] `npm run test:e2e` on the merged main (browser smoke tests, local mode).
- [ ] `node scripts/smoke.mjs` against the real database and storage.
