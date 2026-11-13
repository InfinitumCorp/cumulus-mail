# Read-only IMAP bridge: scope

Status: **phase 1 and phase 2 (server side) built, off by default** (`MAIL_BRIDGE=on`; writes also need `MAIL_BRIDGE_WRITE=on`); the bridge program itself is not written. `src/lib/mail/bridge.ts` holds the placeholder design
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
| 1 | ✅ **built** — app-password tokens (S1 variant), S2 UIDs/UIDVALIDITY/modseq, S3 incremental reads, rate limits | done |
| 2 | Bridge core: IMAP parser/serializer, LOGIN/LIST/SELECT/FETCH/UID, STARTTLS, keychain | ~2 weeks |
| 3 | S4 raw bodies + BODYSTRUCTURE, S5 search mapping, IDLE polling | ~1 week |
| 4 | Packaging (macOS/Windows/Linux signing), setup guide, testing with Thunderbird, Apple Mail, Outlook | ~1–2 weeks |

## What phase 1 actually built

Server-side only, and **off unless `MAIL_BRIDGE=on`**: with the flag off the route answers 404, no token
can be made or used, and no bridge row is ever written.

| Piece | Where |
|---|---|
| Flag and limits (`MAIL_BRIDGE`, `MAIL_BRIDGE_MAX_TOKENS`, `MAIL_BRIDGE_RATE_PER_MINUTE`, `MAIL_BRIDGE_PAGE_SIZE`) | `src/lib/mail/bridge/config.ts` |
| App passwords: random `cmb_…`, shown once, stored only as a SHA-256 hash, fixed `imap:read` scope, revocable | `src/lib/mail/bridge/tokens.ts` |
| UIDVALIDITY / UID / modseq, never reusing a UID; a move is an expunge here and a new UID there | `src/lib/mail/bridge/uids.ts` |
| Incremental read and the per-token rate limit | `src/lib/mail/bridge/sync.ts` |
| `POST /api/bridge/sync` (404 while off, 401 without a token, 429 over the limit) | `src/routes/api/bridge/sync.ts` |
| Tables `bridge_tokens`, `message_uids`, `bridge_folders` | `migrations/0012_bridge.sql` |

Phase 1 took **app passwords instead of S1's device sign-in**. A device flow through Cumulus ID is the
better end state (it reuses the signed-in devices list), but it needs changes on the ID side; an app
password is revocable, read-only by scope, and enough for a local bridge to be built against. S1 stays
on the list for when the ID flow exists.

Not in phase 1: raw RFC 822 bodies (S4) and search (S5), which the bridge needs before it can serve
`FETCH BODY[]` or `SEARCH`.

## What phase 2 added (server side)

Still server-side only; the bridge program itself is not written. Everything stays **off by default**:
- IDLE needs `MAIL_BRIDGE=on`.
- MOVE and APPEND need **both** `MAIL_BRIDGE=on` and `MAIL_BRIDGE_WRITE=on`, **and** a token created with
  `write: true`.
- Turning `MAIL_BRIDGE_WRITE` off makes every write token read-only again at once, without revoking
  anything.

| Piece | What it does | Where |
|---|---|---|
| `imap:write` scope | Added to a token only on request, only while writes are on. Checked on every call. A read token on a write route gets **403**. | `bridge/config.ts`, `bridge/tokens.ts`, `bridge/http.ts` |
| **IDLE** — `POST /api/bridge/idle` `{folder, sinceModseq}` | Long poll. Answers as soon as the folder's modseq passes `sinceModseq`, or after `MAIL_BRIDGE_IDLE_SECONDS` (default 25, max 60) with `changed: false`. Stops when the client disconnects. Keeps no per-connection state on the server. | `bridge/idle.ts` |
| **MOVE** — `POST /api/bridge/move` `{from, to, uids}` | UID MOVE (RFC 6851). Returns the destination's UIDVALIDITY and `[old, new]` UID pairs for COPYUID. Each message moves by compare-and-swap on its folder, so a message the app moved in the meantime is skipped, not overwritten. Refuses Drafts or Quarantine as a target, refuses Quarantine as a source (release has its own checks), refuses unknown folders. | `bridge/write.ts` |
| **APPEND** — `POST /api/bridge/append?folder=sent` (body: the raw RFC 822 message) | Files **sent copies only**. Rules below the table. Returns UIDVALIDITY and the new UID (APPENDUID), 201. | `bridge/write.ts` |
| Inbound mail gets its UID on arrival | Phase 1 only assigned UIDs on a snapshot write, so a bridge, and so an IDLE, missed new mail until the web app next saved. | `inbound.ts` → `noteNewMessage` |

APPEND rules:
- The folder must be Sent.
- `From` must be one of the mailbox's own addresses, so APPEND cannot plant "received" mail.
- Size up to `MAIL_BRIDGE_APPEND_BYTES` (default 25 MB).
- Storage quota is enforced when `MAIL_ENFORCE_STORAGE` is on.
- The message is stored sealed, raw bytes included.
- Flags: `\Seen` is set unless `?seen=0`; `?flagged=1` sets `\Flagged`.
- The same bytes twice give the same UID: 200, `duplicate: true`.

Still refused through the bridge: STORE (flags), COPY, EXPUNGE, CREATE, DELETE and RENAME.

Known limit: the web app saves whole snapshots. A web client holding an older snapshot can therefore put a
bridge-moved message back on its next save. This already applies to every write outside the web client,
and needs per-message writes in the app to fix.

## Owner decisions

- **B1** Local bridge (recommended) or hosted IMAP per region.
- **B2** Packaging: desktop app (tray) or CLI first.
- **B3** Plan gating: which plans get the bridge (`docs/plans.md` has no bridge row yet).
- **B4** Russia: same bridge build pointed at `ru.mail.cumuluscloud.app`, distributed without blocked
  stores/CDNs.
- **B5** Later: flags (STORE) and SMTP submission (MOVE and APPEND for sent copies are built behind `MAIL_BRIDGE_WRITE`, phase 2) through the bridge, which need the outbound
  path (#40) live first.
