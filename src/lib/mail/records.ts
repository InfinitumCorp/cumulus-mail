import type { ArchitectTask, Attachment, Contact, MailMessage, MailRule, Person } from "./model.ts";
import { assertTenantId } from "../storage/adapter.ts";
import { assertId, asFolder, asPeople, type MailProfile, type MailboxSnapshot } from "./snapshot.ts";
import type { MailQuery } from "./query.ts";
import { withTransaction } from "./query.ts";

type MessageRow = {
  id: string;
  thread_id: string;
  folder: string;
  from_name: string;
  from_email: string;
  to_json: string;
  cc_json: string;
  subject: string;
  body: string;
  sent_at: string;
  unread: boolean;
  starred: boolean;
  labels_json: string;
  snooze_until: string | null;
  delivery_json: string | null;
  raw_key: string | null;
  auth_json: string | null;
};

type AttachmentRow = {
  id: string;
  message_id: string;
  name: string;
  size: number;
  content_type: string;
  sha256: string;
  object_key: string;
};

export type StoredAttachment = Attachment & { objectKey: string };

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function rowToMessage(row: MessageRow, attachments: Attachment[]): MailMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    folder: asFolder(row.folder),
    from: { name: row.from_name, email: row.from_email },
    to: asPeople(parseJson<Person[]>(row.to_json, [])),
    cc: asPeople(parseJson<Person[]>(row.cc_json, [])),
    subject: row.subject,
    body: row.body,
    at: row.sent_at,
    unread: row.unread === true,
    starred: row.starred === true,
    labels: parseJson<string[]>(row.labels_json, []).filter((label) => typeof label === "string"),
    attachments: attachments.length ? attachments : undefined,
    delivery: row.delivery_json ? parseJson(row.delivery_json, undefined) : undefined,
    snoozeUntil: row.snooze_until ?? undefined,
    auth: row.auth_json ? parseJson(row.auth_json, undefined) : undefined,
  };
}

export async function loadAttachmentMap(db: MailQuery, tenantId: string): Promise<Map<string, StoredAttachment[]>> {
  assertTenantId(tenantId);
  const rows = await db.query<AttachmentRow>(
    `select id, message_id, name, size, content_type, sha256, object_key
     from cumulus_mail.attachments where tenant_id = $1`,
    [tenantId],
  );
  const map = new Map<string, StoredAttachment[]>();
  for (const row of rows) {
    const file: StoredAttachment = {
      id: row.id,
      name: row.name,
      size: Number(row.size),
      contentType: row.content_type,
      sha256: row.sha256,
      objectKey: row.object_key,
    };
    const list = map.get(row.message_id) ?? [];
    list.push(file);
    map.set(row.message_id, list);
  }
  return map;
}

export async function readSnapshot(db: MailQuery, tenantId: string): Promise<MailboxSnapshot> {
  assertTenantId(tenantId);
  const boxes = await db.query<{
    address: string;
    display_name: string;
    cid: string;
    plan: string;
    quota_gb: number;
    signature: string;
  }>(
    `select address, display_name, cid, plan, quota_gb, signature
     from cumulus_mail.mailboxes where tenant_id = $1`,
    [tenantId],
  );
  const box = boxes[0];
  if (!box) throw new Error("Mailbox not found");
  const attachments = await loadAttachmentMap(db, tenantId);
  const messages = await db.query<MessageRow>(
    `select id, thread_id, folder, from_name, from_email, to_json, cc_json, subject, body, sent_at,
            unread, starred, labels_json, snooze_until, delivery_json, raw_key, auth_json
     from cumulus_mail.messages where tenant_id = $1`,
    [tenantId],
  );
  const aliases = await db.query<{ address: string }>(
    `select address from cumulus_mail.aliases where tenant_id = $1 order by address`,
    [tenantId],
  );
  const contacts = await db.query<Contact & { note: string }>(
    `select id, name, email, org, note from cumulus_mail.contacts where tenant_id = $1`,
    [tenantId],
  );
  const tasks = await db.query<{ id: string; title: string; detail: string; done: boolean; message_id: string | null }>(
    `select id, title, detail, done, message_id from cumulus_mail.tasks where tenant_id = $1`,
    [tenantId],
  );
  const rules = await db.query<{ id: string; from_match: string; action: string; label: string | null }>(
    `select id, from_match, action, label from cumulus_mail.rules where tenant_id = $1`,
    [tenantId],
  );
  const briefs = await db.query<{ brief_key: string; body: string }>(
    `select brief_key, body from cumulus_mail.briefs where tenant_id = $1`,
    [tenantId],
  );
  const briefMap: Record<string, string> = {};
  for (const brief of briefs) briefMap[brief.brief_key] = brief.body;
  return {
    me: {
      name: box.display_name,
      email: box.address,
      cid: box.cid,
      plan: box.plan,
      quotaGb: Number(box.quota_gb),
    },
    messages: messages.map((row) =>
      rowToMessage(
        row,
        (attachments.get(row.id) ?? []).map(({ objectKey: _objectKey, ...file }) => file),
      ),
    ),
    aliases: aliases.map((row) => row.address),
    briefs: briefMap,
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      detail: task.detail,
      done: task.done === true,
      messageId: task.message_id ?? undefined,
    })),
    contacts,
    signature: box.signature,
    rules: rules
      .filter((rule) => rule.action === "star" || rule.action === "archive" || rule.action === "label")
      .map((rule) => ({
        id: rule.id,
        from: rule.from_match,
        action: rule.action as MailRule["action"],
        label: rule.label ?? undefined,
      })),
  };
}

export async function previousRawKeys(db: MailQuery, tenantId: string): Promise<Map<string, string | null>> {
  const rows = await db.query<{ id: string; raw_key: string | null }>(
    `select id, raw_key from cumulus_mail.messages where tenant_id = $1`,
    [tenantId],
  );
  return new Map(rows.map((row) => [row.id, row.raw_key]));
}

export async function insertMessage(
  db: MailQuery,
  tenantId: string,
  message: MailMessage,
  rawKey: string | null,
): Promise<void> {
  assertTenantId(tenantId);
  assertId(message.id, "message id");
  assertId(message.threadId, "thread id");
  await db.query(
    `insert into cumulus_mail.messages (
       tenant_id, id, thread_id, folder, from_name, from_email, to_json, cc_json, subject, body,
       sent_at, unread, starred, labels_json, snooze_until, delivery_json, raw_key, auth_json
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18
     )
     on conflict (tenant_id, id) do update set
       thread_id = excluded.thread_id,
       folder = excluded.folder,
       from_name = excluded.from_name,
       from_email = excluded.from_email,
       to_json = excluded.to_json,
       cc_json = excluded.cc_json,
       subject = excluded.subject,
       body = excluded.body,
       sent_at = excluded.sent_at,
       unread = excluded.unread,
       starred = excluded.starred,
       labels_json = excluded.labels_json,
       snooze_until = excluded.snooze_until,
       delivery_json = excluded.delivery_json,
       raw_key = coalesce(excluded.raw_key, cumulus_mail.messages.raw_key),
       auth_json = excluded.auth_json`,
    [
      tenantId,
      message.id,
      message.threadId,
      asFolder(message.folder),
      message.from.name.slice(0, 200),
      message.from.email.slice(0, 320),
      JSON.stringify(message.to),
      JSON.stringify(message.cc),
      message.subject.slice(0, 500),
      message.body,
      message.at,
      message.unread,
      message.starred,
      JSON.stringify(message.labels),
      message.snoozeUntil ?? null,
      message.delivery ? JSON.stringify(message.delivery) : null,
      rawKey,
      message.auth ? JSON.stringify(message.auth) : null,
    ],
  );
}

export async function insertAttachment(
  db: MailQuery,
  tenantId: string,
  messageId: string,
  file: StoredAttachment,
): Promise<void> {
  assertId(file.id ?? "", "attachment id");
  await db.query(
    `insert into cumulus_mail.attachments (
       tenant_id, id, message_id, name, size, content_type, sha256, object_key
     ) values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (tenant_id, id) do update set
       message_id = excluded.message_id,
       name = excluded.name,
       size = excluded.size,
       content_type = excluded.content_type,
       sha256 = excluded.sha256,
       object_key = excluded.object_key`,
    [tenantId, file.id, messageId, file.name, file.size, file.contentType, file.sha256, file.objectKey],
  );
}

export async function replaceMailboxContents(
  db: MailQuery,
  tenantId: string,
  snapshot: MailboxSnapshot,
  files: Array<{ messageId: string; file: StoredAttachment }>,
  rawKeys: Map<string, string | null>,
): Promise<void> {
  assertTenantId(tenantId);
  await withTransaction(db, async () => {
    await db.query(`delete from cumulus_mail.attachments where tenant_id = $1`, [tenantId]);
    await db.query(`delete from cumulus_mail.messages where tenant_id = $1`, [tenantId]);
    await db.query(`delete from cumulus_mail.aliases where tenant_id = $1`, [tenantId]);
    await db.query(`delete from cumulus_mail.contacts where tenant_id = $1`, [tenantId]);
    await db.query(`delete from cumulus_mail.tasks where tenant_id = $1`, [tenantId]);
    await db.query(`delete from cumulus_mail.rules where tenant_id = $1`, [tenantId]);
    await db.query(`delete from cumulus_mail.briefs where tenant_id = $1`, [tenantId]);
    await db.query(
      `update cumulus_mail.mailboxes set signature = $2 where tenant_id = $1`,
      [tenantId, snapshot.signature.slice(0, 4000)],
    );
    for (const message of snapshot.messages) {
      await insertMessage(db, tenantId, message, rawKeys.get(message.id) ?? null);
    }
    for (const entry of files) {
      await insertAttachment(db, tenantId, entry.messageId, entry.file);
    }
    for (const alias of snapshot.aliases) {
      await db.query(
        `insert into cumulus_mail.aliases (tenant_id, address) values ($1, $2) on conflict do nothing`,
        [tenantId, alias],
      );
    }
    for (const contact of snapshot.contacts) {
      assertId(contact.id, "contact id");
      await db.query(
        `insert into cumulus_mail.contacts (tenant_id, id, name, email, org, note) values ($1,$2,$3,$4,$5,$6)`,
        [tenantId, contact.id, contact.name.slice(0, 200), contact.email.slice(0, 320), contact.org.slice(0, 200), contact.note.slice(0, 2000)],
      );
    }
    for (const task of snapshot.tasks) {
      assertId(task.id, "task id");
      await db.query(
        `insert into cumulus_mail.tasks (tenant_id, id, title, detail, done, message_id) values ($1,$2,$3,$4,$5,$6)`,
        [tenantId, task.id, task.title.slice(0, 300), task.detail.slice(0, 2000), task.done, task.messageId ?? null],
      );
    }
    for (const rule of snapshot.rules) {
      assertId(rule.id, "rule id");
      await db.query(
        `insert into cumulus_mail.rules (tenant_id, id, from_match, action, label) values ($1,$2,$3,$4,$5)`,
        [tenantId, rule.id, rule.from.slice(0, 320), rule.action, rule.label?.slice(0, 80) ?? null],
      );
    }
    for (const [key, text] of Object.entries(snapshot.briefs)) {
      await db.query(
        `insert into cumulus_mail.briefs (tenant_id, brief_key, body) values ($1,$2,$3)`,
        [tenantId, key.slice(0, 2000), text.slice(0, 8000)],
      );
    }
  });
}

export async function readProfile(db: MailQuery, tenantId: string): Promise<MailProfile | null> {
  const rows = await db.query<{
    address: string;
    display_name: string;
    cid: string;
    plan: string;
    quota_gb: number;
  }>(
    `select address, display_name, cid, plan, quota_gb from cumulus_mail.mailboxes where tenant_id = $1`,
    [tenantId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    name: row.display_name,
    email: row.address,
    cid: row.cid,
    plan: row.plan,
    quotaGb: Number(row.quota_gb),
  };
}

export type { ArchitectTask, Contact, MailRule };
