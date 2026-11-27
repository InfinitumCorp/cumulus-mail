# Proton Mail parity

Checked against the public Proton Mail product on 10 Nov 2026, and again on 19 Nov 2026 for keys, zero-access bodies, and a mailbox second factor:

- [proton.me/mail](https://proton.me/mail)
- [Proton Mail support](https://proton.me/support/mail)
- [Addresses and aliases](https://proton.me/support/addresses-and-aliases)
- [Filters](https://proton.me/support/email-inbox-filters)
- [Plans](https://proton.me/support/proton-plans)
- [IMAP, SMTP, and Bridge](https://proton.me/support/imap-smtp-and-pop3-setup)
- [Read receipts](https://proton.me/support/read-receipts)

Statuses: **existing** (already in this repo), **added** (this change), **deferred** (not shipped, with the reason).

The mail shell — header, sidebar, list, reader, and the account dialog chrome — is unchanged, except for the custom-folder rows at the end of the sidebar's folder list and the Inbox category tab row. New controls sit in the composer toolbar, the account dialog, the contacts list, the reader column, and the `/p/$token` unlock route.

| Feature | Status | Notes |
| --- | --- | --- |
| Encryption at rest (AES-256-GCM on bodies, headers, addresses) | existing | `field-crypto.ts`, `storage/crypto.ts`. The key is `MAIL_BLOB_KEY`. |
| Zero-access encryption (server cannot decrypt the mailbox) | partial | Message bodies are sealed to the mailbox OpenPGP key once one is saved (`extra.zeroAccess`). The server still holds `MAIL_BLOB_KEY` and can open the outer field, the subject, and any mailbox that has not created a key. The passphrase never leaves the browser, so the server cannot open the inner layer. |
| End-to-end marker for Cumulus-to-Cumulus mail | existing | Delivery stays inside the app. The stored body is still sealed with the tenant key. |
| OpenPGP between users | added | If every recipient has a public key, the composer encrypts and signs before save, including the sender's own key so the sent copy can be opened. The private key is passphrase-encrypted and saved with the mailbox. The passphrase is not stored. |
| PGP key generate, import, export | added | Account dialog, same rows as the rest. Export of the private key is still passphrase-encrypted. An unlocked private key is refused and not written. |
| WKD and Autocrypt | added | Published keys are served at `/.well-known/openpgpkey/…`. Outbound SMTP adds an Autocrypt header. A recipient with no key on the contact is looked up here, then on their own WKD. |
| Automatic key directory on Cumulus://ID | added | Mail publishes and looks up keys at `CID_KEYS_URL` (default `https://id.cumuluscloud.app/api/keys`). Contract: `docs/cumulus-id-keys.md`. The identity worker is another repository and still has to host that route. |
| Post-quantum encryption | added | Hybrid ML-KEM-768 + X25519 (`cmh1.`). Classic OpenPGP remains for recipients without a PQ key. Secrets are passphrase-wrapped. |
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
| Server-side scheduler when the tab is closed | added | The inbound worker (`cumulus-mail-inbound`) runs a cron every minute (`triggers.crons`, and `dist/inbound/schedules.json` for the Workers API). It moves due drafts to Sent and delivers them, and releases expired undo holds (`src/lib/mail/release.ts`). It finds due drafts by an indexed `due_at` column that holds only the send time rounded down to the hour (`infinity` when there is no schedule; migration 0009). The exact time stays encrypted. An edit saved in the app after the cron reads a draft wins; that draft waits for the next run. The worker is not deployed by this repo, so production still needs the worker and its schedule set. |
| Undo send | added | Existing undo toast, plus a hold (default 10s, max 30s) before delivery is recorded. |
| Snooze | added | Tomorrow morning (the clock button), this weekend, or next week. All at 08:00 UTC. |
| Contacts | existing | |
| Contact groups | added | Up to 8 names, stored with the other sealed contact fields. |
| Encrypted contact fields (phone, postal address, OpenPGP key) | added | Sealed with the tenant key. The ciphertext does not contain the phone number. |
| Calendar list | existing | |
| Calendar invite view | added | A `VCALENDAR` body can be added to this mailbox’s calendar. |
| Calendar recurrence and RSVP | added | Invites with an RRULE (DAILY, WEEKLY, MONTHLY, YEARLY; INTERVAL, COUNT, UNTIL, BYDAY including ordinals like `2TU` or `-1FR`, BYMONTH, BYMONTHDAY), EXDATE and RDATE show the rule, and the calendar list shows the next occurrences up to 60 days ahead. Accept, Maybe and Decline save the answer and send an RFC 5546 iTIP REPLY to the organizer through the normal send path. Internal organizers get it right away; outside ones wait in the Outbox like other outside mail. A REPLY is not shown as a new invite. |
| Recurrence: BYMONTH, BYMONTHDAY, YEARLY with BYDAY, RDATE | added | "4th Thursday of November" (`FREQ=YEARLY;BYMONTH=11;BYDAY=4TH`), "the 1st and 15th" (`BYMONTHDAY=1,15`), the last day of the month (`BYMONTHDAY=-1`), Friday the 13th, and extra dates (RDATE, also without an RRULE) show their repeats; RDATE is kept and published in the calendar feed. |
| Calendar sharing | added | Each event can be shared as an iTIP REQUEST. The copy is sealed on delivery when the recipient has a key. Events stay inside the encrypted mailbox settings. |
| Search over decrypted mail | existing | Runs in the client after the mailbox is opened. |
| Server blind index (subject, from, to, snippet equality) | existing | HMAC under the tenant key. |
| `label:`, `in:`, `is:encrypted` | added | |
| Encrypted token index | added | HMAC tokens. The stored index does not contain the words. |
| Cross-device content-search index | added | Tokens are HMACs under a key derived from the passphrase (`indexKey`). The sealed index can be stored on the mailbox. Subjects of keyed mail are hybrid ciphertext, so the server does not index those words. |
| Attachments up to 25 MB | existing | |
| Attachments encrypted to the mailbox key | added | When a hybrid key exists, inbound attachment bytes are sealed (`application/vnd.cumulus.hybrid`) and opened in the browser before the download. |
| Attachment share links | existing | |
| Large files via Cumulus://Cloud | added | Over 25 MB becomes `https://drive.cumuluscloud.app/s/…`. |
| Uploading those bytes to Drive | deferred | The stub does not transfer the file. No Drive API is called. |
| Read receipts | added | Request in the composer. The reader can send or ignore. |
| Remote image blocking | added | `<img src="https://…">` is stripped. On by default. |
| Link confirmation | added | Links in a message open only after a confirm dialog. Suspicious hosts are called out. |
| Phishing heuristics | added | Lookalike Cumulus domains, punycode, quarantine auth, urgent off-site links. Report uses the existing abuse intake. |
| Block sender | added | Blocks that address for this mailbox only. It does not vote on the shared domain reputation. Report spam still does both. |
| SPF, DKIM, DMARC, quarantine, suppression | existing | |
| Provider-scale spam and phishing reputation | added | Free feeds, on unless `MAIL_SPAM_FEEDS=off`: URLhaus hosts file and the public malware-filter domain list. A feed that is down does not quarantine mail. The mailbox lists and `MAIL_RBL_ZONES` still apply. |
| 2FA, passkeys, security keys | added | Cumulus://ID still enrolls the account factor. This mailbox can also require its own authenticator (TOTP) or a security key (ES256 or Ed25519). The TOTP secret is sealed with the tenant key. Recovery codes are stored only as SHA-256. The mailbox locks for 12 hours after the last success, and only once a factor is enrolled, so a new mailbox is not locked. |
| Session list | done | Account dialog lists Mail's own Better Auth sessions (device, last active, shortened IP) with sign-out per device and for all others. Hidden when sign-in is off. Sessions on the identity provider itself (Cumulus ID) are not listed: this repo has no session API for that issuer. |
| Mailbox audit log | added | Recent account actions, kept on the mailbox settings. It is not the Firmament ledger. |
| Import / export | existing | Server backup. |
| Import / export in the account dialog | added | JSON backup, `.eml` and mbox. Gmail and Outlook: **partly built** (the OAuth start exists, the callback route does not), so off until `MAIL_PROVIDER_IMPORT=on` with `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` or `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET`. |
| IMAP/SMTP bridge | partial | Server API is **off unless `MAIL_BRIDGE=on`** (#194). `node bridge/cumulus-bridge.mjs` listens on 127.0.0.1 only, but is a stub: it does not fetch the mailbox yet and serves an empty INBOX. Writes still need `MAIL_BRIDGE_WRITE=on`. Sending stays in the web app so the mailbox key is not handed to the bridge. |
| POP3 | deferred | Proton does not offer POP3. Neither does this app. |
| Multiple addresses per account | added | See aliases. |
| Signatures | existing | |
| Dark mode for the mail shell | added (opt-in) | Settings → Appearance: Light (default), Dark, or Device (follow the operating system). The default stays Light so the shell is unchanged for everyone who does not choose otherwise (the layout rule); making Device the default is an owner decision. Every colour comes from the five theme tokens, so dark is a second set of them; contrast on the dark background is 7.5:1 or better for all text. |
| Phone layout (under 768px) | added | One column: list, then message, with back; folders in a full-screen drawer; Compose as a full-screen sheet; Compose moves into the title row; touch targets at least 44px. The layout rule was waived for small screens only, and the desktop layout is pixel-identical (checked at 1280px and 800px). Screenshots: `docs/screenshots/mobile-390/`. |
| Language menu in the header | added | The interface-language menu sits in the mail header's `#lang-switch` slot: at the right end of the header row on wider screens, and in the title row (44px touch height) on phones. It used to float bottom-left, where it covered the sidebar's FIRM card and, on an 800px-tall window, the storage meter. **The layout rule was waived for this row only (owner, 2026-11-16).** At 1280px the rest of the header is pixel-identical; at 800px the search field is narrower by the menu's width. Pages without the mail header (sign-in, legal, share links) keep the floating menu, which hides while a dialog is open. `e2e/lang-picker.e2e.mjs` checks 1280x800 and 360px, in English and Russian. |
| Keyboard shortcuts | existing, extended | `c r e # j k x u z`, plus `a` reply all, `f` forward, `/` to search (Esc clears, then leaves), `o` or Enter to open, and Esc back to the list with focus on the row that was open. The open row scrolls into view. |
| Shortcut help | added | `?` |
| Keyboard and screen-reader access | added | A visible focus ring on every control for keyboard users (drawn inset so panes cannot clip it). Dialogs are `aria-modal`, take focus when they open, keep Tab inside, close on Esc (except Compose, so a draft is not lost), and give focus back. The open list row has `aria-current`. Reduced-motion is respected. The layout is unchanged. |
| Installable PWA | done | `public/manifest.webmanifest` (192/512 and maskable icons) and an offline page from `public/sw.js`, which caches the shell and hashed assets only, never pages, API responses or mail. |
| Offline mailbox | not built | The service worker does not cache mail. Earlier builds wrote a passphrase-sealed copy of the open mail to IndexedDB at key unlock, but nothing read it and nothing removed it at sign-out; it is no longer written and any copy is deleted on load and at sign-out. Offline reading needs a design that clears at sign-out. |
| External SMTP to the public internet | added (off by default) | A provider-neutral transport, an env-configured SMTP client (STARTTLS or TLS, AUTH PLAIN), DKIM `rsa-sha256` relaxed/relaxed, and a queue with backoff whose bounces go through the DSN code and suppression list. With no `MAIL_SMTP_HOST`, mail stays held in the outbox as before. Attachments are sent as `multipart/mixed` up to 24 MB. Password-protected mail is still held. Setup: `docs/deploy/outbound-smtp.md`. Nothing is deployed or configured by this repo. |
| Inbox categories and subscription manager | added | A tab row in the Inbox only (All, Primary, Updates, Promotions, Social, Subscriptions). Categories come from List-Id, List-Unsubscribe, Precedence, Auto-Submitted, bulk-mail headers, social sender domains and no-reply senders. Mail with none of these stays Primary. Subscriptions group list mail by List-Id or sender. Unsubscribe uses RFC 8058 one-click when offered: the server POSTs to the URL from the stored message, public https hosts only, no redirects. Otherwise it sends the mailto request, which waits in the Outbox like other outside mail, or opens the page after a confirm. |
| Native desktop and mobile apps | added | The PWA is the app. `apps/capacitor` and `apps/expo` wrap `https://mail.cumuluscloud.app` without a second UI. See `apps/README.md`. |
