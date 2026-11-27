# Delta save: flush the last change on the way out

Status: built (25 Nov). Post-launch item from #86. Code: `src/lib/mail/delta.ts`, `writeDelta` in `src/lib/mail/mailbox.ts`, `src/routes/api/mailbox/delta.ts`, and the `pagehide` flush in `src/lib/mail/store.ts`.

## The problem
Every change saves the **whole mailbox** (`putMailbox`, `src/lib/mail/store.ts` → `writeSnapshot`,
`src/lib/mail/mailbox.ts`). A full snapshot is far over the 64 KB a `keepalive` request may carry, so a
change made a moment before the page closes can't be sent on the way out. What exists today:
- **while a save is in flight**, leaving asks first (`beforeunload`; e2e in #191);
- **a hung save** times out after 60 s and is retried (#196).

What was still lost before this: a change whose save hadn't started or finished when the tab was closed
anyway, or killed by a phone OS.

## The idea
Send only what changed, and let the server rebuild the full snapshot and run it through the **same**
`writeSnapshot`, so none of its checks are duplicated:
- plan limits;
- folder reconciliation;
- alias checks;
- the sealed-message rules;
- the `server_rev` conflict rule (#161).

### Wire format (`MailboxDelta`)
```ts
type MailboxDelta = {
  base: Record<string, number>;      // revs of the messages below, as this tab last saw them
  upsert: MailMessage[];             // changed or new messages, metadata and body; no inline file bytes
  remove: string[];                  // ids this tab deleted
  fields?: Partial<Omit<MailboxSnapshot, "messages" | "me" | "revs">>; // settings, contacts, tasks… only when changed
};
```
A typical delta (one message flagged read, moved, or one draft) is a few KB. A delta over **60 KB**, or one
carrying file bytes, isn't sent on unload: those still go through the full save, with the prompt.

### Server (`applyDelta`, next to `writeSnapshot`)
1. `current = readSnapshot(db, tenant)`.
2. `messages` = `current.messages` with each `upsert` replacing the same id (or appended), minus `remove`.
3. `snapshot = { ...current, ...fields, messages, knownIds: ids of current.messages, knownRevs: { ...current.revs, ...delta.base } }`.
   - `knownIds` = everything on the server, so nothing the tab didn't mention is deleted.
   - `knownRevs` takes the tab's `base` for the messages it sent. A message the server changed since then
     keeps the server's copy, exactly as a full save does today.
4. `writeSnapshot(db, storageFor, tenant, snapshot)`.
5. Bump `server_rev` on the upserted messages. The full save the delta stands in for may still be on the
   wire with an older copy, and may land after the delta. With the bump it loses for those messages, by
   the same rule that protects a scheduled release from an older tab. Without it, the e2e test caught
   exactly that: the older save put the trashed conversation back.

Attachments of upserted messages are referenced by id only, so `writeSnapshot` keeps the stored blobs
(its `previous?.file.objectKey` branch).

### Route
The keepalive request can't go through `createServerFn`. A custom `fetch` with `keepalive` is accepted, but
the client middleware awaits an import before the request starts, and an unloading page runs no later
`await`. So it is a plain `POST /api/mailbox/delta` with the same session checks as the server functions:
- the same-site / CSRF check;
- the session cookie or bearer;
- the second-factor gate.

It also has its own rate-limit bucket (`delta`, 120 an hour per mailbox) and a 64 KiB body cap.

### Client (`store.ts`)
- Track `dirtyIds` (message ids touched by `commit` since the last successful save) and `dirtyFields`.
  The store is immutable, so a changed message is a new object: diff by identity against the last
  saved snapshot.
- On `pagehide` / `visibilitychange: hidden` with `dirty && pushing === 0` (a change not yet sent),
  build the delta and send it with `fetch(..., { keepalive: true })`, at most once per change.
- While a full save is in flight, keep today's prompt: the delta could race it. After an acknowledged
  delta, the next full save carries the same state, so a duplicate is harmless.

## Tests
- **Unit (`applyDelta`):**
  - an upsert, a remove and a fields-only delta each give the same stored mailbox as the equivalent full
    save;
  - a stale `base` keeps the server copy;
  - a delta can't touch `me`, plan or quota;
  - a delta can't add inline bytes;
  - limits are still enforced.
- **e2e (`e2e/save-unload.e2e.mjs`):** trash a conversation while every full save is held, then close the
  tab, accepting the prompt. In the next tab, the conversation is in Trash.
- **authz:sweep:** the new route refuses a caller with no session (401) and a cross-site caller (403).

## Known limit
The bump protects the messages the delta *changed*. If the older full save lands after the delta, it can
still bring back a message the delta *removed*, or put back settings, contacts, rules or aliases the delta
changed. Those carry no per-item rev. It needs that ordering (the earlier request reaching the server after
the later one), and it is no worse than the loss without a delta. Fixing it needs a per-tab save sequence
checked on the server. Every message the tab knew carries the rev it saw (0 when the server listed none),
so a copy the server changed since is never overwritten or deleted by a delta.

## Not in scope
- Per-message server writes (`writeSnapshot` still rewrites the mailbox).
- Making normal saves smaller. That would follow from the same `applyDelta`, and is the next step once
  unload is covered.
