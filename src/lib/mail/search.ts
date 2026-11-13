/**
 * Server-side encrypted word search.
 *
 * Each message's words (subject, sender, recipients, body) are stored in `message_words` (migration
 * 0011), one row per message, only as per-tenant HMACs (`blindIndex(tenant, "word", token)`), never as
 * text. A search blinds its words with the same tenant key and matches them, so the database never sees a
 * plaintext word. What it can see: how many words a message has and which messages
 * share a word (equal HMACs), the usual cost of a deterministic blind index. Whole words only: no prefix
 * or fuzzy matching.
 *
 * Ranking: every query word must match somewhere in the message (AND). Score is the sum of field weights
 * over the matched words (subject 4, sender 3, recipients 2, body 1); ties go to the newest message.
 * Results come in pages with an opaque cursor.
 */
import { blindIndex } from "./field-crypto.ts";
import type { MailMessage } from "./model.ts";
import type { MailQuery } from "./query.ts";
import { assertTenantId } from "../storage/adapter.ts";

export const WORD_FIELDS = { subject: 4, from: 3, to: 2, body: 1 } as const;
export type WordField = keyof typeof WORD_FIELDS;

const MIN_LEN = 2;
const MAX_LEN = 40;
const MAX_TOKENS_PER_FIELD: Record<WordField, number> = { subject: 64, from: 16, to: 64, body: 1500 };
const MAX_QUERY_TERMS = 8;
const MAX_OFFSET = 5000;

/** Lower-case words of letters and digits (any script), 2-40 characters, de-duplicated, in order. */
export function tokenize(text: string, limit = Number.POSITIVE_INFINITY): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < MIN_LEN || raw.length > MAX_LEN || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
    if (out.length >= limit) break;
  }
  return out;
}

/** The words of a message by field. Sender and recipients include their names and address parts. */
export function messageWords(message: MailMessage): Record<WordField, string[]> {
  const people = (list: Array<{ name: string; email: string }>) => list.map((p) => `${p.name} ${p.email}`).join(" ");
  return {
    subject: tokenize(message.subject, MAX_TOKENS_PER_FIELD.subject),
    from: tokenize(`${message.from.name} ${message.from.email}`, MAX_TOKENS_PER_FIELD.from),
    to: tokenize(people([...message.to, ...message.cc]), MAX_TOKENS_PER_FIELD.to),
    body: tokenize(message.body, MAX_TOKENS_PER_FIELD.body),
  };
}

export function wordBlind(tenantId: string, token: string): string {
  return blindIndex(tenantId, "word", token);
}

/** Replace a message's word row (one upsert). Called whenever the message is written. */
export async function indexMessageWords(db: MailQuery, tenantId: string, message: MailMessage): Promise<void> {
  assertTenantId(tenantId);
  const words = messageWords(message);
  const blind = (list: string[]) => list.map((word) => wordBlind(tenantId, word));
  const subject = blind(words.subject);
  const sender = blind(words.from);
  const recipients = blind(words.to);
  const body = blind(words.body);
  const all = [...new Set([...subject, ...sender, ...recipients, ...body])];
  await db.query(
    `insert into cumulus_mail.message_words (tenant_id, message_id, subject, sender, recipients, body, all_words)
     values ($1, $2, $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
     on conflict (tenant_id, message_id) do update set
       subject = excluded.subject, sender = excluded.sender, recipients = excluded.recipients,
       body = excluded.body, all_words = excluded.all_words`,
    [tenantId, message.id, subject, sender, recipients, body, all],
  );
}

export type SearchHit = { id: string; score: number };
export type SearchPage = { hits: SearchHit[]; nextCursor: string | null; terms: number };

/** Opaque page cursor: the offset, bound to the query so a cursor cannot be replayed on another one. */
export function encodeCursor(offset: number, terms: string[]): string {
  return Buffer.from(JSON.stringify({ o: offset, q: terms.join(" ").slice(0, 200) })).toString("base64url");
}

export function decodeCursor(cursor: string | null | undefined, terms: string[]): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString()) as { o?: unknown; q?: unknown };
    const offset = Number(parsed.o);
    if (parsed.q !== terms.join(" ").slice(0, 200)) return 0;
    return Number.isInteger(offset) && offset >= 0 && offset <= MAX_OFFSET ? offset : 0;
  } catch {
    return 0;
  }
}

/**
 * Ranked, paged search over one mailbox. Trash and spam are left out unless `folders` names them.
 */
export async function searchMessages(
  db: MailQuery,
  tenantId: string,
  query: string,
  options: { limit?: number; cursor?: string | null; folders?: string[] } = {},
): Promise<SearchPage> {
  assertTenantId(tenantId);
  const terms = tokenize(query, MAX_QUERY_TERMS);
  if (terms.length === 0) return { hits: [], nextCursor: null, terms: 0 };
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 25), 1), 100);
  const offset = decodeCursor(options.cursor, terms);
  const blinds = terms.map((term) => wordBlind(tenantId, term));
  const exclude = ["trash", "spam"].filter((folder) => !(options.folders ?? []).includes(folder));
  // Score: for each query word, the weight of the best field it appears in (subject 4, sender 3,
  // recipients 2, body 1), summed. The GIN index on all_words answers "every word matches".
  const rows = await db.query<{ message_id: string; score: string | number }>(
    `select w.message_id,
            (select sum(case when t = any(w.subject) then 4 when t = any(w.sender) then 3
                             when t = any(w.recipients) then 2 else 1 end)
               from unnest($2::text[]) as t) as score
       from cumulus_mail.message_words w
       join cumulus_mail.messages m on m.tenant_id = w.tenant_id and m.id = w.message_id
      where w.tenant_id = $1
        and w.all_words @> $2::text[]
        and not (m.folder = any($3::text[]))
      order by score desc, m.sent_at desc, w.message_id
      limit $4 offset $5`,
    [tenantId, blinds, exclude, limit + 1, offset],
  );
  const hits = rows.slice(0, limit).map((row) => ({ id: row.message_id, score: Number(row.score) }));
  const more = rows.length > limit && offset + limit <= MAX_OFFSET;
  return { hits, nextCursor: more ? encodeCursor(offset + limit, terms) : null, terms: terms.length };
}

export type ReindexReport = { tenants: number; messages: number };

/**
 * Index messages that have no word row yet (mail stored before migration 0011, or delivered to a mailbox
 * nobody has opened since). Idempotent: messages already indexed are skipped. Decrypts with the tenant
 * keys, so it needs MAIL_BLOB_KEY like the app. `apply: false` only counts.
 */
export async function reindexMissingWords(
  db: MailQuery,
  readMessages: (db: MailQuery, tenantId: string) => Promise<MailMessage[]>,
  options: { apply?: boolean; tenantId?: string } = {},
): Promise<ReindexReport> {
  const params: unknown[] = [];
  let tenantFilter = "";
  if (options.tenantId) {
    assertTenantId(options.tenantId);
    params.push(options.tenantId);
    tenantFilter = "and m.tenant_id = $1";
  }
  const missing = await db.query<{ tenant_id: string; id: string }>(
    `select m.tenant_id, m.id from cumulus_mail.messages m
       left join cumulus_mail.message_words w on w.tenant_id = m.tenant_id and w.message_id = m.id
      where w.message_id is null ${tenantFilter}
      order by m.tenant_id`,
    params,
  );
  const byTenant = new Map<string, Set<string>>();
  for (const row of missing) {
    const ids = byTenant.get(row.tenant_id) ?? new Set<string>();
    ids.add(row.id);
    byTenant.set(row.tenant_id, ids);
  }
  if (options.apply) {
    for (const [tenantId, ids] of byTenant) {
      assertTenantId(tenantId);
      for (const message of await readMessages(db, tenantId)) {
        if (ids.has(message.id)) await indexMessageWords(db, tenantId, message);
      }
    }
  }
  return { tenants: byTenant.size, messages: missing.length };
}
