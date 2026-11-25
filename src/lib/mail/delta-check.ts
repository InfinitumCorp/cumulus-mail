import type { MailMessage } from "./model.ts";
import { rejectCallerTenant } from "./snapshot.ts";
import { DELTA_FIELDS, MAX_REMOVE, MAX_UPSERT, type MailboxDelta } from "./delta.ts";

/* Server side only (src/routes/api/mailbox/delta.ts), kept out of delta.ts so the page does not load snapshot.ts. */

const isRecordOfRevs = (value: unknown): value is Record<string, number> =>
  Boolean(value) &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value as object).length <= MAX_UPSERT &&
  Object.values(value as object).every((rev) => Number.isSafeInteger(rev) && rev >= 0);

/** Server-side shape check. The contents are checked by writeSnapshot, as for a full save. */
export function asDelta(input: unknown): MailboxDelta {
  rejectCallerTenant(input);
  if (!input || typeof input !== "object") throw new Error("Missing change");
  const row = input as Record<string, unknown>;
  const upsert = row.upsert;
  const remove = row.remove;
  if (!Array.isArray(upsert) || upsert.length > MAX_UPSERT || upsert.some((message) => !message || typeof message !== "object")) {
    throw new Error("Invalid change");
  }
  if (!Array.isArray(remove) || remove.length > MAX_REMOVE || remove.some((id) => typeof id !== "string")) {
    throw new Error("Invalid change");
  }
  if (!isRecordOfRevs(row.base)) throw new Error("Invalid change");
  if ((upsert as MailMessage[]).some((message) => (message.attachments ?? []).some((file) => file?.dataBase64))) {
    throw new Error("Files are saved with the full save");
  }
  const fields: Record<string, unknown> = {};
  if (row.fields !== undefined) {
    if (!row.fields || typeof row.fields !== "object" || Array.isArray(row.fields)) throw new Error("Invalid change");
    for (const [key, value] of Object.entries(row.fields)) {
      if (!(DELTA_FIELDS as readonly string[]).includes(key)) throw new Error("Invalid change");
      fields[key] = value;
    }
  }
  return {
    base: row.base,
    upsert: upsert as MailMessage[],
    remove: remove as string[],
    ...(Object.keys(fields).length ? { fields: fields as MailboxDelta["fields"] } : {}),
  };
}
