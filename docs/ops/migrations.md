# Migrations 0011–0020: what each adds, and how to undo it

Read `docs/ops/runbook.md` §4–5 first. In short: **roll back the code, keep the schema.** Every migration from
0011 on only **adds** (tables, their indexes and row-level security, two columns with defaults). The code
before each one keeps working on the schema after it, so a bad deploy is undone by deploying the previous
version; the new tables just sit unused. Undo a migration itself only if the migration is the problem
(it fails to apply, or it locks or slows the database), and only with a backup taken first.

## Checked on 2026-11-18 (local PostgreSQL 16)
- **From empty:** `npm run db:migrate` applies 0001–0019 in order; a second run applies nothing;
  `db:status` exits 0.
- **Production-like upgrade:** a database at 0018 with a mailbox written by `main`'s code (60 messages, 10
  with files, Russian subjects) → `db:migrate` applies 0019 → the new code reads it, saves a change, keeps
  every file; `main`'s code (before 0019) also still reads and saves it (that is the "roll back the code"
  path); `npm run drill:restore` passes on the upgraded database (dump, restore into an empty database,
  copy blobs, read back with the key ring).
- **Undo:** the SQL below, run in reverse order on a database at 0019, leaves it at 0010 with `db:status`
  listing 9 pending; `db:migrate` then applies them again and `db:status` exits 0.

## Before undoing anything
1. Deploy the previous code first (runbook §4) and confirm the problem is the migration, not the code.
2. Take a backup: `pg_dump` of the database (runbook, "Backup and restore").
3. Undo **newest first**, one migration at a time, in a transaction, from a machine that reaches the
   database (`psql "$DATABASE_URL" -v ON_ERROR_STOP=1`).
4. Remove its row from `public._migrations` in the same transaction, so `db:migrate` re-applies it later.

## Per migration

| File | Adds | What is lost on undo | Undo |
|---|---|---|---|
| `0024_save_sequences.sql` | `save_sequences` | Nothing that matters: the newest save number per open tab. Without it, a full save still on the wire when a tab closed can undo that tab's last change again (the code falls back) | below |
| `0023_outbound_queue_created.sql` | index `outbound_queue_created` | Nothing: the sign-up wave cap's count reads the whole queue again | below |
| `0022_factor_sessions.sql` | `second_factors.satisfied_sessions`, `totp_last_step`, `failures`, `failures_since` | Each session's second-factor pass (people enter a code again), code-replay and attempt-limit records. The code falls back to one window per mailbox without them | below |
| `0021_wkd_and_factors.sql` (#189) | `wkd_keys`, `second_factors` | Published OpenPGP keys (re-publish from settings) and **every enrolled authenticator, security key and recovery code**: people must enrol again. Undo 0022 first | below |
| `0020_auth_lockdown.sql` (#177) | RLS on, and no rights for `anon` / `authenticated`, on the sign-in tables and `_migrations` | **Do not undo it on Supabase**: it is what keeps session tokens away from the public anon key. Undo only on a database with no Data API | below |
| `0019_message_rev.sql` | `messages.server_rev` | Nothing that matters: stale-tab protection (#161) stops until re-applied | below |
| `0018_spam_votes.sql` | `spam_votes` | The one-vote-per-mailbox record; `sender_reputation` totals stay | below |
| `0017_outbound_safety.sql` | `outbound_pauses`, `mailboxes.send_verified` | Pauses on outbound senders; who is past the new-sender limits | below |
| `0016_calendar_feeds.sql` | `calendar_feeds` | Every calendar subscription URL (people must rotate a new one) | below |
| `0015_spam_controls.sql` | `sender_reputation`, `spam_lists` | Shared reputation and every mailbox's block/allow lists | below |
| `0014_account_deletion.sql` | `account_deletions`, `deletion_audit` | Pending deletion requests **and the audit of completed ones**: export `deletion_audit` first | below |
| `0013_data_exports.sql` | `data_exports` | The once-a-day download record (links already sent stop working) | below |
| `0012_bridge.sql` | `bridge_tokens`, `message_uids`, `bridge_folders` | IMAP app passwords and UIDs: every IMAP client must resync | below |
| `0011_message_words.sql` | `message_words` | The server-side search index; search falls back until `scripts/reindex-words.mjs` runs again | below |

```sql
begin;
-- 0024
drop table if exists cumulus_mail.save_sequences;
delete from public._migrations where name = '0024_save_sequences.sql';
commit;

begin;
-- 0023
drop index if exists cumulus_mail.outbound_queue_created;
delete from public._migrations where name = '0023_outbound_queue_created.sql';
commit;

begin;
-- 0022
alter table cumulus_mail.second_factors drop column if exists satisfied_sessions;
alter table cumulus_mail.second_factors drop column if exists totp_last_step;
alter table cumulus_mail.second_factors drop column if exists failures;
alter table cumulus_mail.second_factors drop column if exists failures_since;
delete from public._migrations where name = '0022_factor_sessions.sql';
commit;

begin;
-- 0021
drop table if exists cumulus_mail.second_factors;
drop table if exists cumulus_mail.wkd_keys;
delete from public._migrations where name = '0021_wkd_and_factors.sql';
commit;

begin;
-- 0020 (never on Supabase: it re-exposes the sign-in tables to the anon key)
alter table public.session disable row level security;
alter table public."user" disable row level security;
alter table public.account disable row level security;
alter table public.verification disable row level security;
alter table public._migrations disable row level security;
delete from public._migrations where name = '0020_auth_lockdown.sql';
commit;

begin;
-- 0019
alter table cumulus_mail.messages drop column if exists server_rev;
delete from public._migrations where name = '0019_message_rev.sql';
commit;

begin;
-- 0018
drop table if exists cumulus_mail.spam_votes;
delete from public._migrations where name = '0018_spam_votes.sql';
commit;

begin;
-- 0017
drop table if exists cumulus_mail.outbound_pauses;
alter table cumulus_mail.mailboxes drop column if exists send_verified;
delete from public._migrations where name = '0017_outbound_safety.sql';
commit;

begin;
-- 0016
drop table if exists cumulus_mail.calendar_feeds;
delete from public._migrations where name = '0016_calendar_feeds.sql';
commit;

begin;
-- 0015
drop table if exists cumulus_mail.spam_lists;
drop table if exists cumulus_mail.sender_reputation;
delete from public._migrations where name = '0015_spam_controls.sql';
commit;

begin;
-- 0014 (export cumulus_mail.deletion_audit first: it is the record that erasures happened)
drop table if exists cumulus_mail.deletion_audit;
drop table if exists cumulus_mail.account_deletions;
delete from public._migrations where name = '0014_account_deletion.sql';
commit;

begin;
-- 0013
drop table if exists cumulus_mail.data_exports;
delete from public._migrations where name = '0013_data_exports.sql';
commit;

begin;
-- 0012
drop table if exists cumulus_mail.bridge_folders;
drop table if exists cumulus_mail.message_uids;
drop table if exists cumulus_mail.bridge_tokens;
delete from public._migrations where name = '0012_bridge.sql';
commit;

begin;
-- 0011
drop table if exists cumulus_mail.message_words;
delete from public._migrations where name = '0011_message_words.sql';
commit;
```

The code that uses a table must not be running when the table is dropped: deploy the version from before
that migration first (the table names above say which features stop).
