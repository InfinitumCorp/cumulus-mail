import type { MailMessage } from "./model.ts";
import type { MailboxSnapshot } from "./snapshot.ts";

/**
 * A small save: what changed since the last snapshot the server acknowledged. The page sends it with
 * `keepalive` as it goes away (store.ts), when a full save is still on the wire or waiting for a retry,
 * so a change made just before closing the tab is not lost. The server rebuilds the whole snapshot from
 * what it has and runs it through the same `writeSnapshot` as a full save (mailbox.ts `writeDelta`), so
 * every check (plan limits, folders, aliases, sealed messages, stale copies) applies unchanged.
 * docs/design/delta-save.md.
 */
export type MailboxDelta = {
  /** The revs this tab last received, for the upserted messages: an older copy loses to the server's. */
  base: Record<string, number>;
  upsert: MailMessage[];
  remove: string[];
  fields?: Partial<Pick<MailboxSnapshot, DeltaField>>;
};

export const DELTA_FIELDS = ["aliases", "briefs", "tasks", "contacts", "signature", "rules", "settings"] as const;
export type DeltaField = (typeof DELTA_FIELDS)[number];

/** Browsers refuse a keepalive body over 64 KiB; leave room for the request's own wrapping. */
export const DELTA_MAX_BYTES = 60_000;
export const MAX_UPSERT = 200;
export const MAX_REMOVE = 2_000;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The delta from `saved` (what the server last acknowledged) to `current`, or null when there is nothing
 * to send or it cannot go as a small save: a new file's bytes, or more than DELTA_MAX_BYTES in all.
 */
export function diffSnapshot(
  saved: MailboxSnapshot,
  current: MailboxSnapshot,
  knownRevs: Record<string, number>,
): MailboxDelta | null {
  const before = new Map(saved.messages.map((message) => [message.id, message]));
  const upsert: MailMessage[] = [];
  for (const message of current.messages) {
    const old = before.get(message.id);
    if (old && same(old, message)) continue;
    if ((message.attachments ?? []).some((file) => file.dataBase64)) return null;
    upsert.push(message);
  }
  const now = new Set(current.messages.map((message) => message.id));
  const remove = saved.messages.filter((message) => !now.has(message.id)).map((message) => message.id);
  const fields: Partial<Pick<MailboxSnapshot, DeltaField>> = {};
  for (const key of DELTA_FIELDS) {
    if (!same(saved[key], current[key])) (fields as Record<string, unknown>)[key] = current[key];
  }
  const hasFields = Object.keys(fields).length > 0;
  if (!upsert.length && !remove.length && !hasFields) return null;
  if (upsert.length > MAX_UPSERT || remove.length > MAX_REMOVE) return null;
  // Every message this tab knew and changed or removed carries the rev it saw. The server lists revs only
  // above 0, so a missing one is 0: without it the server would fill in its own current rev, and a copy
  // the server changed since (a released send, a delivery report) would not be recognised as newer.
  const base: Record<string, number> = {};
  for (const message of upsert) if (before.has(message.id)) base[message.id] = knownRevs[message.id] ?? 0;
  for (const id of remove) base[id] = knownRevs[id] ?? 0;
  const delta: MailboxDelta = { base, upsert, remove, ...(hasFields ? { fields } : {}) };
  return new TextEncoder().encode(JSON.stringify(delta)).byteLength <= DELTA_MAX_BYTES ? delta : null;
}

/**
 * The full snapshot a delta stands for, on top of what the server has now (`current`, from readSnapshot).
 * Every message the server has is "known", so only the ones the delta removes are deleted; a message the
 * server changed since the tab's `base` keeps the server's copy, exactly as in a full save.
 */
export function applyDelta(current: MailboxSnapshot, delta: MailboxDelta): MailboxSnapshot {
  const removed = new Set(delta.remove);
  const changed = new Map(delta.upsert.map((message) => [message.id, message]));
  const messages: MailMessage[] = [];
  for (const message of current.messages) {
    if (removed.has(message.id)) continue;
    messages.push(changed.get(message.id) ?? message);
    changed.delete(message.id);
  }
  for (const message of changed.values()) if (!removed.has(message.id)) messages.push(message);
  const { revs, knownIds: _knownIds, knownRevs: _knownRevs, ...rest } = current;
  const serverRevs = revs ?? {};
  return {
    ...rest,
    ...(delta.fields ?? {}),
    messages,
    knownIds: current.messages.map((message) => message.id),
    knownRevs: { ...serverRevs, ...delta.base },
  };
}
