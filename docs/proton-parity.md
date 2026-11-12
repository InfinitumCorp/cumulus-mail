# Proton Mail parity

Checked against the public Proton Mail product on 10 Nov 2026:

- [proton.me/mail](https://proton.me/mail)
- [Proton Mail support](https://proton.me/support/mail)
- [Addresses and aliases](https://proton.me/support/addresses-and-aliases)
- [Filters](https://proton.me/support/email-inbox-filters)
- [Plans](https://proton.me/support/proton-plans)
- [IMAP, SMTP, and Bridge](https://proton.me/support/imap-smtp-and-pop3-setup)
- [Read receipts](https://proton.me/support/read-receipts)

Statuses: **existing** (already in this repo), **added** (this change), **deferred** (not shipped, with the reason).

The mail shell — header, sidebar, list, reader, and the account dialog chrome — is unchanged, except for the custom-folder rows at the end of the sidebar's folder list. New controls sit in the composer toolbar, the account dialog, the contacts list, the reader column, and the `/p/$token` unlock route.

| Feature | Status | Notes |
| --- | --- | --- |
| Encryption at rest (AES-256-GCM on bodies, headers, addresses) | existing | `field-crypto.ts`, `storage/crypto.ts`. The key is `MAIL_BLOB_KEY`. |
| Zero-access encryption (server cannot decrypt the mailbox) | deferred | The server holds `MAIL_BLOB_KEY` and opens fields to build the snapshot. A client-held mailbox key would replace that model. |
| End-to-end marker for Cumulus-to-Cumulus mail | existing | Delivery stays inside the app. The stored body is still sealed with the tenant key. |
| OpenPGP between users | added | Optional. If every recipient has a public key on the contact, the composer encrypts before save. The private key is created for the browser tab and is not written to the mailbox. |
| Automatic key directory on Cumulus://ID | deferred | No key-publish API on `id.cumuluscloud.app` is wired here. |
| Post-quantum encryption | deferred | Proton announced it in 2026. This client does not implement a PQ KEM. |
| Password-protected mail to external recipients | added | PBKDF2 + AES-GCM. The password is not stored. External SMTP is still held. |
| Expiration | added | Default 7 days on the envelope. Opening after that fails. |
| Self-destruct / limited reads | added | A successful open spends a read. Self-destruct wipes the ciphertext. The public link is `/p/$token`. |
| Hide-my-email aliases | existing | “Disposable alias” in the account dialog. |
| Plus addressing (`name+tag@domain`) | added | Routes to the base address. An exact address still wins. |
| Additional addresses on the platform domain | added | Account dialog, cap 15. |
| Custom domains | added | Up to 3. Verification is a TXT record `_cumulus-mail.<domain>` = `cumulus-mail-verify=cumuluscloud.app`. |
| Catch-all | added | Published only after that TXT check succeeds. |
| Live DNS and registrar changes | deferred | The default resolver is empty unless `MAIL_AUTH_DNS=live`. This change does not edit DNS. |
| Paid plan billing | deferred (scoped) | No payment provider. Caps mirror a paid mailbox (3 domains, 15 addresses) without charging. Tiers, Stripe objects, where each limit is enforced, and the order of work are in `docs/plans.md`. |
| Labels | existing | Shown on the message. |
| System folders (inbox, sent, drafts, archive, trash, quarantine, snoozed, starred, outbox) | existing | |
| Custom folders in the sidebar | added | Up to 50 folders, listed under the system folders in the same row style. Create, rename and delete in the sidebar; "Move to" in the reader moves a conversation (Sent and Drafts copies stay put); Archive works from a folder. Deleting a folder moves its mail back to the Inbox, and a save from an older tab does the same for mail in a folder that no longer exists. Folder names are stored in the encrypted settings. The layout rule was waived for this row only. |
| Simple filters (from → star, archive, label) | existing | Account dialog, and Mute in the reader. |
| Sieve subset | added | `if header\|address :contains\|:is "From\|Subject\|To"`, then `fileinto`, `addflag "\Starred"`, `stop`. `fileinto` takes a system folder, `label:Name`, or a custom folder name (`"Receipts"` or `"folder:Receipts"`). Bad scripts, including one naming a folder that no longer exists, are stored but not applied; the account dialog says why. |
| Auto-reply | added | One reply per sender per day. It does not answer an auto-reply. |
| Scheduled send | added | Stays in Drafts until the time, then Sent on the next save, within a few seconds while the app is open, or by the worker cron within about a minute when it is closed. |
| Server-side scheduler when the tab is closed | added | The inbound worker (`cumulus-mail-inbound`) runs a cron every minute (`triggers.crons`, and `dist/inbound/schedules.json` for the Workers API). It moves due drafts to Sent and delivers them, and releases expired undo holds (`src/lib/mail/release.ts`). An edit saved in the app after the cron reads a draft wins; that draft waits for the next run. The worker is not deployed by this repo, so production still needs the worker and its schedule set. |
| Undo send | added | Existing undo toast, plus a hold (default 10s, max 30s) before delivery is recorded. |
| Snooze | existing | Until 08:00 UTC the next day. |
| Contacts | existing | |
| Encrypted contact fields (phone, postal address, OpenPGP key) | added | Sealed with the tenant key. The ciphertext does not contain the phone number. |
| Calendar list | existing | |
| Calendar invite view | added | A `VCALENDAR` body can be added to this mailbox’s calendar. |
| Full calendar (recurrence, RSVP, sharing) | deferred | The calendar page stays a list. Proton Calendar is a separate app. |
| Search over decrypted mail | existing | Runs in the client after the mailbox is opened. |
| Server blind index (subject, from, to, snippet equality) | existing | HMAC under the tenant key. |
| `label:`, `in:`, `is:encrypted` | added | |
| Encrypted token index | added | HMAC tokens. The stored index does not contain the words. |
| Cross-device content-search index | deferred | Proton’s downloadable index needs a client-held mailbox key. |
| Attachments up to 25 MB | existing | |
| Attachment share links | existing | |
| Large files via Cumulus://Cloud | added | Over 25 MB becomes `https://drive.cumuluscloud.app/s/…`. |
| Uploading those bytes to Drive | deferred | The stub does not transfer the file. No Drive API is called. |
| Read receipts | added | Request in the composer. The reader can send or ignore. |
| Remote image blocking | added | `<img src="https://…">` is stripped. On by default. |
| Link confirmation | added | Links in a message open only after a confirm dialog. Suspicious hosts are called out. |
| Phishing heuristics | added | Lookalike Cumulus domains, punycode, quarantine auth, urgent off-site links. Report uses the existing abuse intake. |
| SPF, DKIM, DMARC, quarantine, suppression | existing | |
| Provider-scale spam and phishing reputation | deferred | No external reputation feed. |
| 2FA, passkeys, security keys | deferred | Enrolled on Cumulus://ID (`https://id.cumuluscloud.app`). Mail does not store a second factor. The account dialog says so. |
| Session list from Cumulus://ID | deferred | This repo has no session API for that issuer. |
| Mailbox audit log | added | Recent account actions, kept on the mailbox settings. It is not the Firmament ledger. |
| Import / export | existing | Server backup. |
| Import / export in the account dialog | added | |
| IMAP/SMTP bridge | deferred | Design only: IMAP `127.0.0.1:1143`, SMTP `127.0.0.1:1025`, STARTTLS, decrypt on the machine that holds the key. Nothing listens. |
| POP3 | deferred | Proton does not offer POP3. Neither does this app. |
| Multiple addresses per account | added | See aliases. |
| Signatures | existing | |
| Dark mode for the mail shell | deferred | The shell is light. Adding a theme would restyle it, which the layout rule forbids. Sign-in and error pages already ship `dark:` classes; those pages were not restyled. |
| Phone layout (under 768px) | added | One column: list, then message, with back; folders in a full-screen drawer; Compose as a full-screen sheet; Compose moves into the title row; touch targets at least 44px. The layout rule was waived for small screens only, and the desktop layout is pixel-identical (checked at 1280px and 800px). Screenshots: `docs/screenshots/mobile-390/`. |
| Keyboard shortcuts | existing | `c r e # j k x u z`. |
| Shortcut help | added | `?` |
| Installable PWA | existing | `/__grok/manifest.webmanifest` and the install page. |
| Offline mailbox | deferred | No service worker caches messages. Offline mail needs a client-held key. |
| Inbox categories and subscription manager | deferred | Those are separate inbox layouts. |
| External SMTP to the public internet | added (off by default) | A provider-neutral transport, an env-configured SMTP client (STARTTLS or TLS, AUTH PLAIN), DKIM `rsa-sha256` relaxed/relaxed, and a queue with backoff whose bounces go through the DSN code and suppression list. With no `MAIL_SMTP_HOST`, mail stays held in the outbox as before. Attachments and password-protected mail are still held. Setup: `docs/deploy/outbound-smtp.md`. Nothing is deployed or configured by this repo. |
| Native desktop and mobile apps | deferred | This repo is the web client. |
