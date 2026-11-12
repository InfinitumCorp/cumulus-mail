# Paid plans: scoping

Status: **proposal**. No payment code exists yet, and nothing here is wired up. This document maps paid tiers
onto the limits the code already has, lists the Stripe objects needed, shows where each limit is (or is not)
enforced today, and gives an order of work. Prices are placeholders for the owner to set.

## 1. What the code limits today

| Limit | Value today | Where it is checked | Enforced on the server? |
| --- | --- | --- | --- |
| Plan name | `"Free"` | `mailboxes.plan` column (`migrations/0002_cumulus_mail.sql`), set when a mailbox is provisioned in `src/lib/mail/mailbox.server.ts` (`plan: "Free"`) | Stored, never read for a decision |
| Storage | 15 GB | `mailboxes.quota_gb` column, same provisioning code (`quotaGb: 15`). Shown by `quota()` in `src/lib/mail/logic.ts` | **No.** `quota()` is display only, and its usage figure is an estimate (a fixed base plus message and attachment sizes) |
| Addresses (aliases) | 15 | `addAlias` in `src/lib/mail/store.ts` (`aliases.length >= 15`) | **No.** `writeSnapshot` in `src/lib/mail/mailbox.ts` stores any number. A client can bypass the limit |
| Custom domains | 3 | `sanitizeSettings` in `src/lib/mail/settings.ts` (`.slice(0, 3)`) | Yes (extra domains are dropped silently) |
| Custom folders | 50 | `MAX_FOLDERS` in `src/lib/mail/folders.ts` (`createFolder`, `sanitizeFolders`) | Yes |
| Messages per mailbox | 5,000 | `MAX_MESSAGES` in `src/lib/mail/mailbox.ts` | Yes (save fails) |
| Attachment size | 25 MB each | `MAX_ATTACHMENT` in `src/lib/mail/mailbox.ts` | Yes |
| Attachments per message | 8 | `MAX_FILES` in `src/lib/mail/mailbox.ts` and `src/components/mail/composer.tsx` | Yes |
| Outbound SMTP | off | `MAIL_SMTP_HOST` env (PR #40, not merged) | Platform-wide on/off, not per plan |

`docs/proton-parity.md` describes the current numbers as mirroring "a paid mailbox (3 domains, 15 addresses)
without charging". Today every mailbox gets the paid-mailbox limits for free.

## 2. Proposed tiers

| | Free | Plus | Pro | Business (per seat) |
| --- | --- | --- | --- | --- |
| Price | 0 | _owner to set_ | _owner to set_ | _owner to set_ |
| Storage (`quota_gb`) | 1 GB | 15 GB | 50 GB | 50 GB |
| Addresses (aliases) | 1 | 15 | 30 | 30 |
| Custom domains | 0 | 3 | 5 | 10 |
| Custom folders | 10 | 50 | 50 | 50 |
| Messages | 5,000 | 50,000 | 100,000 | 100,000 |
| Outbound to the internet (SMTP) | Held (as today) | Yes | Yes | Yes |
| Catch-all on a custom domain | No | Yes | Yes | Yes |

Notes:

- **Plus matches today's limits** (15 GB, 15 addresses, 3 domains). Existing mailboxes can become Plus,
  or be grandfathered (see §5), and nobody's mailbox shrinks.
- The message limit is also a performance guard: the whole mailbox is sent as one snapshot. Raising it above
  about 5,000 needs paging in `readSnapshot` and `writeSnapshot` first. Treat the higher numbers as aims, not
  launch values.
- Per-message limits (25 MB, 8 files) stay the same for every tier. They protect delivery, not revenue.

## 3. Data model changes

One migration, `000N_plans.sql`:

```sql
alter table cumulus_mail.mailboxes
  add column if not exists plan_id text not null default 'free',      -- free | plus | pro | business
  add column if not exists plan_status text not null default 'active', -- active | past_due | canceled
  add column if not exists plan_renews_at timestamptz,
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text;
create unique index if not exists mailboxes_stripe_customer on cumulus_mail.mailboxes (stripe_customer_id)
  where stripe_customer_id is not null;
-- Webhook idempotency.
create table if not exists cumulus_mail.billing_events (
  id text primary key,            -- Stripe event id
  type text not null,
  received_at timestamptz not null default now()
);
alter table cumulus_mail.billing_events enable row level security;
```

- The existing `plan` (display text) and `quota_gb` columns stay, and are written from `plan_id`, so current
  readers (`readProfile`, `readSnapshot`, the sidebar quota bar) keep working unchanged.
- Stripe ids are not secret, but they are linkable. Keep them out of the client snapshot.

## 4. Enforcement: one place

Add `src/lib/mail/plans.ts`:

```ts
export type PlanId = "free" | "plus" | "pro" | "business";
export type Limits = { quotaGb: number; aliases: number; domains: number; folders: number; messages: number; smtp: boolean; catchAll: boolean };
export const PLANS: Record<PlanId, Limits> = { /* the table in §2 */ };
export function limitsFor(planId: string, status: string): Limits; // past_due keeps the plan for a grace period; canceled → free
```

Then replace each hard-coded number with `limitsFor(...)`, server first:

| Check | Change |
| --- | --- |
| Addresses | **New server check** in `writeSnapshot` (`mailbox.ts`): reject a save that has more aliases than the plan allows. Keep the client check in `store.ts` for the message, using the profile's limit |
| Domains | `sanitizeSettings` takes the limit instead of `3`. Drop the silent `.slice()` in favour of a clear error on save, so users know why a domain vanished |
| Folders | `MAX_FOLDERS` becomes the plan's value in `createFolder` and `sanitizeFolders` |
| Messages | `MAX_MESSAGES` becomes the plan's value (see the paging note) |
| Storage | **New:** measure real usage (sum of attachment sizes plus raw blobs per tenant, kept as a running total on save and delivery). Refuse new attachments over quota, but **always accept incoming mail** and show the warning instead (bouncing mail for a billing reason is hostile and causes support load) |
| SMTP | `deliverMessage` (`delivery.ts`, PR #40) queues outside mail only when the sender's plan has `smtp`. Otherwise it keeps today's "held" line, with an upgrade hint |
| Catch-all | `routedAddresses` in `records.ts` publishes the catch-all only when the plan has `catchAll` |

`MailProfile` (`snapshot.ts`) gains `limits`, so the UI shows real numbers instead of constants.

## 5. Stripe objects

| Object | Use |
| --- | --- |
| **Product** per tier (Plus, Pro, Business) | Names and descriptions on Checkout and invoices |
| **Price** per product × interval (monthly, yearly), with `lookup_key` such as `plus_monthly` | The code refers to lookup keys, never price ids, so prices can change without a deploy |
| **Customer**, one per mailbox (`metadata.tenant_id`) | Created on first checkout and stored in `stripe_customer_id` |
| **Checkout Session** (`mode: subscription`) | Upgrade from Free. `client_reference_id = tenant_id`. Taxes via Stripe Tax if enabled |
| **Subscription** | Source of truth for `plan_id`, `plan_status` and `plan_renews_at`. Business uses `quantity` = seats |
| **Customer Portal** session | Change plan, update card, cancel, invoices. No custom billing UI needed |
| **Webhook endpoint** | `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated` and `customer.subscription.deleted`, and `invoice.payment_failed` → update the mailbox row. Verify the signature and record `event.id` in `billing_events` before acting (idempotent) |

Secrets to add when this is built (in the platform secret store, never in the repo): `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`. The publishable key is not needed if Checkout is used through a redirect.

Server functions (in `src/lib/mail/api.ts`, same `authMiddleware` pattern as the others):
`startCheckout({ priceLookupKey })` returns a URL, and `openBillingPortal()` returns a URL. The webhook is a plain route
(`src/routes/api/billing/webhook.ts`) with no session, verified by signature only.

## 6. Order of work

1. **Close the alias gap now**, independent of billing: add the server-side 15-address check to `writeSnapshot`
   with a test. A client can currently store any number of addresses. Small PR. *(Done: #52.)*
2. Migration (§3) plus `plans.ts` (§4), with every mailbox set to `plus`. **No behaviour change**: the limits
   equal today's. Tests for `limitsFor` and each converted check. *(Done: `migrations/0010_plans.sql`,
   `src/lib/mail/plans.ts`. Addresses, domains, folders, messages and catch-all read the plan. Storage and
   SMTP limits are defined but not enforced yet.)*
3. Real storage accounting (running total, backfill script). Display it; don't enforce yet.
4. Stripe in **test mode**: products and prices (made by a script from the §2 table), Checkout, Portal, and the
   webhook with signature verification, idempotency and tests using Stripe's fixture events.
5. Account panel: plan name, usage against limits, Upgrade (Checkout) and Manage billing (Portal) buttons.
   This is new UI in the account dialog; the shell is unchanged.
6. Decide grandfathering: existing mailboxes either stay on Plus limits for free (`plan_id = 'plus'`,
   no subscription) or are told N days ahead and moved to Free. **Owner decision.**
7. Switch new sign-ups to Free, turn on enforcement (§4), then go live in Stripe.

## 7. Open questions for the owner

- Prices, currencies, and whether to offer a yearly discount.
- Grandfathering existing mailboxes (step 6).
- Whether Business needs admin features first (shared domains, seat management), or launches as "Pro per seat".
- Tax: Stripe Tax on or off, and which regions.
- Whether storage is shared with Cumulus Drive (the quota bar says "shared with Drive"). If so, the storage
  limit belongs to the Cumulus://ID account, not the mailbox, and this plan moves to the ID service.
