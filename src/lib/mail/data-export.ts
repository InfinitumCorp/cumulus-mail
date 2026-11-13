/**
 * "Download my data": the right of access (152-ФЗ ст. 14, GDPR art. 15).
 *
 * Two files, each decrypted only for the person asking:
 *   - `messages.mbox` — every message, in mboxrd (RFC 4155). Mail that arrived from outside is the
 *     original RFC 822 bytes as stored; mail written in the app is rebuilt, with its attachments as
 *     MIME parts. Streamed one message at a time, so the response is never one huge string.
 *   - `data.json` — account, contacts, calendar, folders, aliases, rules, tasks, settings, signature.
 *
 * Each file can be downloaded once a day per mailbox. The limit is claimed atomically in the database
 * when the download starts, so a replayed link or two tabs cannot get around it.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { assertTenantId } from "../storage/adapter.ts";
import type { TenantBlobs } from "../storage/index.ts";
import type { MailMessage } from "./model.ts";
import type { MailQuery } from "./query.ts";
import { loadAttachmentMap, previousRawKeys, readSnapshot, type StoredAttachment } from "./records.ts";
import type { MailboxSnapshot } from "./snapshot.ts";

export type ExportPart = "mbox" | "json";
export const EXPORT_PARTS: readonly ExportPart[] = ["mbox", "json"];
export const DAY_MS = 24 * 3_600_000;
/** A download link works for five minutes. */
export const TOKEN_TTL_MS = 5 * 60_000;

/* ---------------- the once-a-day limit ---------------- */

/**
 * Claim today's download of `part`. True when this call got it; false when the mailbox already
 * downloaded it in the last 24 hours. One statement, so two requests cannot both win.
 */
export async function claimExport(db: MailQuery, tenantId: string, part: ExportPart, now = new Date()): Promise<boolean> {
  assertTenantId(tenantId);
  const rows = await db.query<{ last_at: string | Date }>(
    `insert into cumulus_mail.data_exports (tenant_id, part, last_at) values ($1, $2, $3)
     on conflict (tenant_id, part) do update set last_at = excluded.last_at
       where cumulus_mail.data_exports.last_at <= $4
     returning last_at`,
    [tenantId, part, now.toISOString(), new Date(now.getTime() - DAY_MS).toISOString()],
  );
  return rows.length > 0;
}

/** When `part` can next be downloaded, or null when it can be now. */
export async function nextExportAt(db: MailQuery, tenantId: string, part: ExportPart, now = new Date()): Promise<Date | null> {
  assertTenantId(tenantId);
  const rows = await db.query<{ last_at: string | Date }>(
    `select last_at from cumulus_mail.data_exports where tenant_id = $1 and part = $2`,
    [tenantId, part],
  );
  const last = rows[0] ? new Date(rows[0].last_at).getTime() : null;
  if (last === null || now.getTime() - last >= DAY_MS) return null;
  return new Date(last + DAY_MS);
}

/* ---------------- the download link ---------------- */

/**
 * A short-lived signed link: `<tenant>.<part>.<expiry>.<hmac>`. The session check happens in the server
 * function that issues it (same-site, bearer, Cumulus ID); the download route only verifies the HMAC.
 * The key is derived from `MAIL_BLOB_KEY`, which every deployment has and never leaves the server.
 */
function linkKey(env: Record<string, string | undefined> = process.env): Buffer {
  const secret = env.MAIL_BLOB_KEY?.trim();
  if (!secret) throw new Error("MAIL_BLOB_KEY is not set");
  return createHmac("sha256", secret).update("cumulus-mail/data-export/v1").digest();
}

const sign = (payload: string, key: Buffer) => createHmac("sha256", key).update(payload).digest("base64url");

export function exportToken(tenantId: string, part: ExportPart, now = Date.now(), env?: Record<string, string | undefined>): string {
  assertTenantId(tenantId);
  const payload = `${Buffer.from(tenantId).toString("base64url")}.${part}.${now + TOKEN_TTL_MS}`;
  return `${payload}.${sign(payload, linkKey(env))}`;
}

export function verifyExportToken(
  token: string,
  now = Date.now(),
  env?: Record<string, string | undefined>,
): { tenantId: string; part: ExportPart } | null {
  const pieces = token.split(".");
  if (pieces.length !== 4) return null;
  const [tenant64, part, expiry, mac] = pieces as [string, string, string, string];
  if (part !== "mbox" && part !== "json") return null;
  if (!/^\d{10,16}$/.test(expiry) || Number(expiry) < now) return null;
  const expected = Buffer.from(sign(`${tenant64}.${part}.${expiry}`, linkKey(env)));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const tenantId = Buffer.from(tenant64, "base64url").toString("utf8");
  try {
    assertTenantId(tenantId);
  } catch {
    return null;
  }
  return { tenantId, part };
}

/* ---------------- data.json ---------------- */

export function dataJson(snapshot: MailboxSnapshot, exportedAt = new Date()): Record<string, unknown> {
  const settings = snapshot.settings;
  return {
    format: "cumulus-mail/data-export",
    version: 1,
    exportedAt: exportedAt.toISOString(),
    account: snapshot.me,
    contacts: snapshot.contacts,
    calendar: settings?.events ?? [],
    folders: settings?.folders ?? [],
    aliases: snapshot.aliases,
    rules: snapshot.rules,
    sieve: settings?.sieve ?? "",
    tasks: snapshot.tasks,
    signature: snapshot.signature,
    settings: settings ?? null,
    messages: { count: snapshot.messages.length, file: "messages.mbox" },
  };
}

/* ---------------- messages.mbox ---------------- */

const encoder = new TextEncoder();

/** mboxrd: a line that starts with any number of `>` followed by `From ` gets one more `>`. */
export function escapeFromLines(text: string): string {
  return text.replace(/^(>*From )/gm, ">$1");
}

const headerValue = (value: string) => value.replace(/[\r\n]+/g, " ").slice(0, 998);
const person = (p: { name: string; email: string }) => {
  const name = headerValue(p.name).replace(/["\\]/g, "");
  return name && name !== p.email ? `"${name}" <${headerValue(p.email)}>` : `<${headerValue(p.email)}>`;
};
const encodeWord = (text: string) => (/^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text).toString("base64")}?=`);
const wrap76 = (base64: string) => base64.replace(/.{1,76}/g, "$&\r\n");

/** The separator line, `From <addr> <asctime>`, as mbox readers expect it. */
export function fromLine(message: Pick<MailMessage, "from" | "at">): string {
  const date = new Date(message.at);
  const valid = Number.isNaN(date.getTime()) ? new Date(0) : date;
  // asctime (`%a %b %e %T %Y`): the day is space-padded, "Jan  1", not "Jan 01".
  const asctime = valid
    .toUTCString()
    .replace(/^(\w+), (\d+) (\w+) (\d+) ([\d:]+) GMT$/, (_, day, date, month, year, time) => `${day} ${month} ${String(Number(date)).padStart(2, " ")} ${time} ${year}`);
  const address = message.from.email.replace(/\s/g, "") || "MAILER-DAEMON";
  return `From ${address} ${asctime}`;
}

/** An RFC 822 message for mail written in the app (no stored original). */
export function rebuildMessage(message: MailMessage, files: Array<{ file: StoredAttachment; body: Uint8Array }> = []): string {
  const headers = [
    `From: ${person(message.from)}`,
    message.to.length ? `To: ${message.to.map(person).join(", ")}` : null,
    message.cc.length ? `Cc: ${message.cc.map(person).join(", ")}` : null,
    `Subject: ${encodeWord(headerValue(message.subject))}`,
    `Date: ${new Date(message.at).toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${message.id}@cumulus-mail.export>`,
    `X-Cumulus-Folder: ${message.folder}`,
    message.labels.length ? `X-Cumulus-Labels: ${headerValue(message.labels.join(", "))}` : null,
    `X-Cumulus-Flags: ${[message.unread ? "" : "Seen", message.starred ? "Flagged" : ""].filter(Boolean).join(" ") || "none"}`,
    "MIME-Version: 1.0",
  ].filter((line): line is string => line !== null);
  const text = wrap76(Buffer.from(message.body, "utf8").toString("base64"));
  if (!files.length) {
    return [...headers, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", text].join("\r\n");
  }
  const boundary = `cumulus-export-${message.id.replace(/[^A-Za-z0-9]/g, "").slice(0, 40)}`;
  const parts = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    text,
    ...files.flatMap(({ file, body }) => [
      `--${boundary}`,
      `Content-Type: ${headerValue(file.contentType ?? "application/octet-stream")}; name="${encodeWord(headerValue(file.name)).replace(/"/g, "")}"`,
      `Content-Disposition: attachment; filename="${encodeWord(headerValue(file.name)).replace(/"/g, "")}"`,
      "Content-Transfer-Encoding: base64",
      "",
      wrap76(Buffer.from(body).toString("base64")),
    ]),
    `--${boundary}--`,
    "",
  ];
  return [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", ...parts].join("\r\n");
}

/** One mbox entry: separator, the message with `From ` lines escaped, a blank line. */
export function mboxEntry(message: MailMessage, rfc822: string): string {
  const body = escapeFromLines(rfc822.replace(/\r\n/g, "\n"));
  return `${fromLine(message)}\n${body.endsWith("\n") ? body : `${body}\n`}\n`;
}

/**
 * The whole mailbox as an mbox stream. Messages are loaded from the database once (decrypted for this
 * tenant only); each message's blobs are read just before it is written, so attachments are never all
 * in memory at once.
 */
export async function mboxStream(db: MailQuery, storage: TenantBlobs, tenantId: string): Promise<ReadableStream<Uint8Array>> {
  assertTenantId(tenantId);
  const snapshot = await readSnapshot(db, tenantId);
  const attachments = await loadAttachmentMap(db, tenantId);
  const raws = await previousRawKeys(db, tenantId);
  const messages = [...snapshot.messages].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index >= messages.length) {
        controller.close();
        return;
      }
      const message = messages[index++]!;
      const rawKey = raws.get(message.id);
      let rfc822: string | null = null;
      if (rawKey) {
        const stored = await storage.get(rawKey).catch(() => null);
        if (stored) rfc822 = new TextDecoder().decode(stored.body);
      }
      if (rfc822 === null) {
        const files: Array<{ file: StoredAttachment; body: Uint8Array }> = [];
        for (const file of attachments.get(message.id) ?? []) {
          const stored = await storage.get(file.objectKey).catch(() => null);
          if (stored) files.push({ file, body: stored.body });
        }
        rfc822 = rebuildMessage(message, files);
      }
      controller.enqueue(encoder.encode(mboxEntry(message, rfc822)));
    },
  });
}

export async function dataJsonText(db: MailQuery, tenantId: string, now = new Date()): Promise<string> {
  assertTenantId(tenantId);
  return `${JSON.stringify(dataJson(await readSnapshot(db, tenantId), now), null, 2)}\n`;
}
