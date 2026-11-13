# Design: rotating `MAIL_BLOB_KEY`

Status: **proposal, not built.** Today the key cannot be rotated (see `docs/ops/runbook.md`, #110). This
page says what rotation would take, so it can be planned and estimated.

## What the key does today

`MAIL_BLOB_KEY` is one 32-byte master key per copy (US, RU). Everything is derived from it per mailbox
(`src/lib/storage/crypto.ts`):

| Use | Derivation | Stored as |
|---|---|---|
| Blobs (raw mail, attachments) | `tenantKey(master, tenant, "blob")`, AES-256-GCM | `[0x01][iv 12][ciphertext][tag 16]` in the bucket |
| Sealed fields (subjects, names, settings…) | `tenantKey(master, tenant, "meta")`, AES-256-GCM | `cm1.` + base64url of the same layout, in Postgres |
| **Blind indexes** (address routing, aliases, the outbound suppression list, scheduled-send lookups; and with open PRs the spam lists #106 and the search index #84) | HMAC under `tenantKey(master, tenant, "blind")` | hex, in Postgres, **used for lookups** |
| Export links, deletion audit (#100, #101) | HMAC keys derived from the master | not stored / an HMAC in `deletion_audit` |

The first byte of every sealed value is a **format version (1)**, but nothing records **which key** sealed
it, and the code reads exactly one key. Changing the variable therefore makes every sealed value
unreadable **and** every blind index wrong, so mail stops routing to the right mailbox.

## Proposal

### 1. Say which key sealed a value

A version-2 layout that names the key:

```
[0x02][key id: 1 byte][iv 12][ciphertext][tag 16]        blobs and fields ("cm2." prefix for fields)
```

- Key ids are small integers. **Version-1 values are key id 0**, so nothing has to be rewritten to start.
- Configuration becomes `MAIL_BLOB_KEYS=0:<old>,1:<new>` plus `MAIL_BLOB_KEY_ACTIVE=1`.
  `MAIL_BLOB_KEY` alone keeps working as key 0 and active, so a deployment that never rotates changes nothing.
- **Reads** pick the key by id. **Writes** always use the active key.
- The key id goes into the GCM additional data, so a value cannot be relabelled with another key's id.

### 2. Blind indexes during the change

A blind index is compared, not decrypted, so it cannot carry a key id inline. During a rotation:

- **Writes** store the index under the **new** key.
- **Lookups** compute the index under **both** keys and match either (two values in the `IN (...)`).
- Each index table gets a `key_id` column, so the re-keying job knows what is left.
- When the job reports no rows with the old key id, lookups go back to one key.

### 3. The re-keying job

`npm run keys:rekey`, one mailbox at a time, resumable, read-mostly:

1. For each tenant: re-seal every `cm1.` / old-key field, re-seal every blob (write the new object, then
   point the row at it, then delete the old object), recompute every blind index.
2. One transaction per tenant for the rows; blobs before rows, as in account deletion, so a crash leaves
   only orphan blobs, which the sweeper (#105) finds.
3. A progress table (`rekey_progress`) so it can stop and resume, and report "N of M mailboxes done".
4. Rate-limited, so it can run on a live copy.

### 4. Retiring the old key

Only when the job reports zero values with the old key id **and** a backup has been restored and opened
with the new key alone. Then remove it from `MAIL_BLOB_KEYS`.

## What it costs

| Part | Size |
|---|---|
| v2 layout, multi-key read, AAD | 1–2 days, plus tests that v1 data still opens |
| Dual-key blind index lookups + `key_id` columns (`directory.ts`, `records.ts`, `suppression.ts`, `release.ts`, and the spam/search tables once merged) | 2–3 days |
| Re-keying job with progress and resume | 2–3 days |
| A rehearsal on a copy of production, US then RU | 1 day each |

## Until then

- **Back up both keys** (US and RU are different) where the team keeps recovery keys. Losing one loses
  every mailbox on that copy.
- If a key is exposed, follow the runbook: rotate the database and bucket credentials at once (an attacker
  needs those too), then schedule this work.
