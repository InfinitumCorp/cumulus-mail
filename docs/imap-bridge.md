# Read-only IMAP bridge: scope

Status: **scoping only**. Nothing here is built. `src/lib/mail/bridge.ts` holds the placeholder design
(IMAP on `127.0.0.1:1143`, STARTTLS) that the account dialog shows, and the parity table lists the bridge as
deferred. This page says what a first, **read-only** bridge would take, so it can be planned and estimated.

## Goal

Let a desktop mail client (Thunderbird, Apple Mail, Outlook) **read** a Cumulus://Mail mailbox over IMAP:
folders, messages, attachments, search. No sending (SMTP), no moving, deleting or flagging in the first
version. The client never gets the user's Cumulus ID password or the server's keys.

## Shape

A small program on the user's computer (the "bridge") signs in to Mail once with Cumulus ID, keeps a
device session, and serves IMAP **only on 127.0.0.1**. The desktop client talks IMAP to the bridge with a
bridge-generated password; the bridge talks HTTPS to Mail.

```
Desktop client --IMAP/STARTTLS, 127.0.0.1:1143--> bridge --HTTPS (device session)--> Mail API (us or ru)
```

Why local and not a hosted `imap.cumuluscloud.app`: a hosted IMAP endpoint needs a long-lived password
that unlocks the whole mailbox on the server, a new public port per region (and a Russian one off
Cloudflare), and abuse handling. Today the server already decrypts the mailbox (it holds `MAIL_BLOB_KEY`),
so local vs hosted is not a cryptography change, but local keeps credentials and the open port on the
user's machine. **Owner decision B1** below.

## What the server needs (none exists yet)

| # | Server piece | Why | Notes |
|---|---|---|---|
| S1 | **Device sign-in**: a Cumulus ID device/authorization-code flow that ends in a Mail session token for the bridge, listed under signed-in devices and revocable | The bridge must not see the Cumulus ID password | Better Auth bearer sessions already work (`bearer()` plugin); the signed-in devices list (#71) shows and revokes them |
| S2 | **Stable IMAP UIDs**: per mailbox and folder, `uidvalidity` + a monotonically increasing `uid` per message, and a `modseq` bumped on any change | IMAP clients cache by UID; the app's message ids are strings | New table `message_uids (tenant_id, folder, uid, message_id, modseq)`; assigned on write; `uidvalidity` changes only if a folder is rebuilt |
| S3 | **Incremental reads**: "messages in folder F with modseq > N", paged | The app's API returns the whole mailbox as one snapshot | Also what snapshot paging needs; reuse for both |
| S4 | **Raw message**: the stored RFC 822 bytes (`raw_key` blob) for `BODY[]`, or a rebuilt message for mail composed in the app | IMAP `FETCH BODY[]` | Read via the existing sealed blob store; size limit per message as today |
| S5 | **Search**: IMAP `SEARCH TEXT/SUBJECT/FROM` | Clients search on the server | The encrypted word index (#84) answers word searches; IMAP substring search becomes word search (documented limitation) |

## The bridge (IMAP4rev1 subset, read-only)

- `CAPABILITY`, `STARTTLS` (self-signed certificate generated per install, pinned in the client setup),
  `LOGIN` with the bridge password (random, shown once), `LOGOUT`, `NOOP`.
- `LIST` / `LSUB`: Inbox, Sent, Drafts, Archive, Spam, Trash, plus custom folders with their names.
- `SELECT` / `EXAMINE` (EXAMINE semantics either way), `STATUS`.
- `UID FETCH` of `FLAGS`, `ENVELOPE`, `BODYSTRUCTURE`, `BODY.PEEK[...]`, `RFC822.SIZE`, `INTERNALDATE`.
  `\Seen` is reported, not changed.
- `UID SEARCH` mapped to S5. `IDLE` by polling S3 every 60 s.
- Every write command (`STORE`, `COPY`, `MOVE`, `APPEND`, `EXPUNGE`, `CREATE`, `DELETE`, `RENAME`) answers
  `NO [CANNOT] read-only bridge`.

Implementation choice: a minimal IMAP server in TypeScript/Node (the subset above is small), packaged as a
signed desktop app or CLI. Off-the-shelf IMAP servers (Dovecot, WildDuck) expect to own the mail store and
do not fit a remote, encrypted store.

## Security

- Listens on 127.0.0.1 only; refuses other interfaces. STARTTLS required before `LOGIN`.
- The bridge password unlocks only the local bridge; the device session it holds is revocable from the web
  (signed-in devices). Stored in the OS keychain, never in a file.
- Read-only by construction: no write calls exist in the bridge's API client.
- Talks only to the user's region (`mail.cumuluscloud.app` or `ru.mail.cumuluscloud.app`), chosen at sign-in.

## Phases and rough size

| Phase | Work | Size |
|---|---|---|
| 1 | S1 device sign-in, S2 UIDs/modseq, S3 incremental reads (shared with snapshot paging) | ~2 weeks |
| 2 | Bridge core: IMAP parser/serializer, LOGIN/LIST/SELECT/FETCH/UID, STARTTLS, keychain | ~2 weeks |
| 3 | S4 raw bodies + BODYSTRUCTURE, S5 search mapping, IDLE polling | ~1 week |
| 4 | Packaging (macOS/Windows/Linux signing), setup guide, testing with Thunderbird, Apple Mail, Outlook | ~1–2 weeks |

## Owner decisions

- **B1** Local bridge (recommended) or hosted IMAP per region.
- **B2** Packaging: desktop app (tray) or CLI first.
- **B3** Plan gating: which plans get the bridge (`docs/plans.md` has no bridge row yet).
- **B4** Russia: same bridge build pointed at `ru.mail.cumuluscloud.app`, distributed without blocked
  stores/CDNs.
- **B5** Later: read-write (flags, moves) and SMTP submission through the bridge, which need the outbound
  path (#40) live first.
