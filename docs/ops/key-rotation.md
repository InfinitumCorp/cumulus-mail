# Rotating `MAIL_BLOB_KEY`

`MAIL_BLOB_KEY` seals every stored blob (raw mail, attachments, shared files) and every encrypted field
(subjects, bodies, addresses, settings…). This page is how to replace it without losing mail. The design
is in `docs/design/blob-key-rotation.md`; the code is `src/lib/storage/keyring.ts` and
`src/lib/storage/rekey.ts`.

The US and RU copies have **separate** keys and are rotated separately. Never copy a key between them.

## How it works

- **`MAIL_BLOB_KEYS`** is an ordered list of `id:key` entries. The **first** is current and seals
  everything new. The rest are only used to read older values.
  Example: `MAIL_BLOB_KEYS=1:<new key>,0:<old key>`.
  Ids are 0–255. Keys are 32 bytes, as hex or base64.
- **Every sealed value records its key id.** Values sealed before this change carry no id and are read as
  key **0**, so today's key is always `0:`.
- **Until `MAIL_BLOB_KEYS` is set, nothing changes.** The app keeps writing the old layout under
  `MAIL_BLOB_KEY`, so deploying this code is safe and can be rolled back.
- **`npm run keys:rekey`** re-seals stored values under the current key:
  - It is a dry run unless you pass `--apply`.
  - It works through mailboxes in id order, in batches, and prints progress after each batch.
  - It skips values already under the current key, so it can be re-run or resumed at any time.
- **Blind indexes do not rotate.** These are the lookup hashes for address routing, aliases, suppressions
  and search.
  - They stay on a separate, stable key: `MAIL_BLIND_KEY` if set, otherwise `MAIL_BLOB_KEY`. So a rotation
    never rebuilds an index.
  - **This is why `MAIL_BLOB_KEY` stays set, unchanged, after a rotation.** From then on it is the blind key
    only.
  - If you prefer, copy its value to `MAIL_BLIND_KEY` first.
  - What this means: someone holding the old key and a copy of the database can still test guesses
    against the lookup hashes (for example "is this address a customer?"). They cannot decrypt anything
    re-keyed.

## Before you start

- **The new code is deployed everywhere in this copy.**
  - US: the API worker and the inbound worker.
  - RU: the container.
- **Back up the new key** in the recovery password manager *before* using it. **Keep the old key** there
  as well: database and bucket backups taken before the rotation are sealed under it.
- **Generate the new key:** `openssl rand -hex 32`.

## Steps

1. **Add the new key as current.** Set `MAIL_BLOB_KEYS=1:<new>,0:<current MAIL_BLOB_KEY>` and leave
   `MAIL_BLOB_KEY` as it is.
   - **US:** add the GitHub secret `MAIL_BLOB_KEYS` in `production-us`, then run "Deploy US" with target
     `both`. The workflow syncs it to both workers.
   - **RU:** add the key `MAIL_BLOB_KEYS` to the Lockbox secret, set the repository variable
     `YC_LOCKBOX_OPTIONAL_KEYS=MAIL_BLOB_KEYS`, then run "Deploy RU".
   - Every component must get the ring in the same deploy. An instance still on the old settings cannot
     read values sealed under key 1.
   - **From this point, do not roll back to a build that predates key rotation.** It cannot read values
     sealed under the new key.

2. **Dry run.** Run it from a machine with the copy's settings: `DATABASE_URL`, `MAIL_BLOB_KEYS`, the
   storage settings (`MAIL_STORAGE`, `MAIL_S3_*`), and `MAIL_BLOB_KEY`.

   ```sh
   npm run keys:rekey
   ```

   It prints counts by key. Expect most values under key `0`, nothing under `unreadable`, and `failed 0`.

3. **Apply.**

   ```sh
   npm run keys:rekey -- --apply            # --batch <n> to change the batch size (default 50)
   ```

   - If it stops, run it again. To skip ahead, pass `--from-tenant <the last mailbox it printed>`.
   - A value the app changed while the run was going is left for the next run. It is not overwritten.
   - Exit codes:
     - `0`: every value is under the current key.
     - `2`: some values are not. Run it again, and read `failed`.
     - `1`: error.

4. **Verify.** Run the dry run again. It must say `0 value(s) would be re-sealed`, with `failed 0`.
   - Then sign in, open old and new mail, and open an attachment.
   - `blobs … missing` counts rows whose blob object no longer exists. This is not caused by the rotation;
     the account-deletion sweeper is the place to look.

5. **Retire the old key.** Set `MAIL_BLOB_KEYS=1:<new>`, removing `0:…`, and deploy again as in step 1.
   - Anything not re-keyed is now unreadable. That is why step 4 comes first.
   - Keep the old key in the password manager for as long as backups sealed under it are kept.
   - Keep `MAIL_BLOB_KEY` set: it is still the blind key.

The next rotation adds `2:<newer>` in front, `MAIL_BLOB_KEYS=2:<newer>,1:<new>`, and repeats steps 2–5.

## If the key is exposed

1. Rotate the database and bucket credentials first. The key is useless without the data.
2. Then do the steps above.
3. Record in the incident note that the old key can still be used to test guesses against the lookup
   hashes, as explained above.

Rebuilding blind indexes under a new `MAIL_BLIND_KEY` is not supported yet. If the incident needs it, it
is an engineering task.

## What `keys:rekey` covers

- **Fields:** every text column, in every `cumulus_mail` table that has a `tenant_id`, whose value is
  sealed (`cm1.`). Tables added later are covered automatically.
- **Blobs:** every blob that a row points at: `messages.raw_key`, `attachments.object_key` and
  `share_grants.blob_id`.
  - Blobs nothing points at (orphans) are not re-keyed. They are unreadable once the old key is removed,
    which is acceptable because they are garbage.
- **Password-protected links:** the stored envelope is a sealed field, so it is re-keyed. The message
  inside it is also sealed with the link's password, and that layer does not change.
- **Not covered:** session secrets, the DKIM key and auth tokens. Each has its own rotation in
  `docs/ops/runbook.md`.
