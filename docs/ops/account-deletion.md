# Account deletion: what the app does, and what an operator does

When someone deletes their mailbox (the account dialog → **Delete mailbox…**), the app waits 7 days, then
hard-deletes every row and blob for it (`src/lib/mail/account-deletion.ts`). This page covers what that
does **not** reach, and who handles it.

## 1. Cumulus ID — the operator, by hand

Cumulus://Mail does not delete the person's **Cumulus ID**. The ID is a separate service shared by every
Cumulus product (Drive, Calendar, …), so deleting a mailbox must not delete the identity behind other
products, and this app has no business calling the ID service's admin APIs. It does not call them.

What the operator does:

1. The deletion shows up as a `deletion_audit` row (no address or id in it — see below).
2. If the person asked for **their whole Cumulus account** to be deleted (not just the mailbox), forward
   the request to whoever operates Cumulus ID, with the date the mailbox was purged. Do not include
   message content or anything from the mailbox: there is none left, and none is needed.
3. To confirm a specific account was deleted when asked (by the person, a regulator or a court), compute
   the HMAC of the mailbox id the same way the app does (`subjectHmac` in `account-deletion.ts`, keyed from
   `MAIL_BLOB_KEY`) and look it up in `cumulus_mail.deletion_audit.subject_hmac`.

Sessions this app holds for the person end with the mailbox: their rows are removed, and the next request
finds no mailbox.

## 2. The Stripe customer — optional, behind a flag

If the mailbox ever paid, Stripe holds a customer record (name, email, payment method fingerprint).

- **`MAIL_DELETE_STRIPE_CUSTOMER=on`** (with billing configured): the purge deletes the Stripe customer
  **first**, before any row, so a Stripe outage aborts the purge with nothing lost and the next scheduler
  tick retries it with the customer id still on file. A customer that is already gone counts as done.
- **Off (the default)**, or billing off: the customer stays in Stripe. Delete it in the Stripe dashboard
  (Customers → the customer → Delete). Stripe keeps payment records it is legally required to keep
  regardless; that is Stripe's obligation, not this app's.

Why a flag: deleting a payment customer is a decision about invoices and refunds that the operator should
make once, deliberately, not a side effect of turning billing on.

## 3. Orphan blobs — the sweeper

The purge finds blobs through the rows that point at them. Bytes with no row (a crash between writing a
blob and its row, or anything left behind by an older bug) are found by the sweeper:

```
DATABASE_URL=… MAIL_STORAGE=s3 MAIL_S3_BUCKET=… MAIL_S3_ENDPOINT=… \
MAIL_S3_ACCESS_KEY_ID=… MAIL_S3_SECRET_ACCESS_KEY=… npm run blobs:sweep            # report only
… npm run blobs:sweep -- --apply                                                   # delete
… npm run blobs:sweep -- --min-age-hours 72                                        # only older ones
```

- **Dry run by default.** It reports counts and sizes per mailbox and deletes nothing until `--apply`.
- A blob younger than a day is never touched: it may belong to a write still in progress.
- The health-check probe blobs are skipped.
- Run it after a batch of deletions, or monthly. It prints no blob contents.

## 4. What survives a deletion

One `deletion_audit` row: when it was asked for, when it was done, and how many rows and blobs were
removed. No content, no address, and the mailbox id only as an HMAC. That is the record that the erasure
happened, which the operator may need to show.

## Region

The US and Russia copies each run their own purge against their own database and storage. A Russian
mailbox's data, its audit row and the sweeper's report all stay in `ru-central1`.
