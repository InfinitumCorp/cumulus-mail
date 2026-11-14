/**
 * Inbound spam controls. Three signals, checked in this order when mail arrives:
 *
 *   1. The mailbox's own lists, trained by "Report spam" / "Not spam". A blocked sender goes to
 *      Quarantine. An allowed sender goes to the Inbox even if the signals below say otherwise —
 *      **but only when the message passed authentication**, so a forged From: of a friend's address
 *      is not let through by the allowlist.
 *   2. Sender reputation: counters per sending domain shared by every mailbox. A domain with enough
 *      reports, and mostly spam ones, goes to Quarantine for everyone.
 *   3. An RBL lookup (a domain blocklist such as Spamhaus DBL), **off unless `MAIL_RBL_ZONES` is set**.
 *
 * Quarantine, not rejection: a false positive costs the person a click in Quarantine, not lost mail.
 */
import { assertTenantId } from "../storage/adapter.ts";
import { blindIndex } from "./field-crypto.ts";
import type { MailAuth } from "./model.ts";
import type { MailQuery } from "./query.ts";

export type SpamVerdict =
  | { folder: "inbox"; reason: "allowlisted" | "clean" }
  | { folder: "quarantine"; reason: "blocklisted" | "reputation" | "rbl" | "authentication" };

/** A domain needs this many reports before its reputation counts, so one person cannot sink it. */
export const MIN_REPORTS = 5;
/** And this share of its reports must be "spam" rather than "not spam". */
export const SPAM_SHARE = 0.8;

const listKey = (tenantId: string, address: string) => blindIndex(tenantId, "spam-list", address);

/** The registrable-ish part of an address: `news.shop.example` -> `news.shop.example` (exact; no PSL). */
export function senderDomain(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at < 1) return null;
  const domain = address.slice(at + 1).trim().toLowerCase().replace(/\.$/, "");
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain) ? domain : null;
}

/* ---------------- per-mailbox lists ---------------- */

export async function listKind(db: MailQuery, tenantId: string, address: string): Promise<"block" | "allow" | null> {
  assertTenantId(tenantId);
  const rows = await db.query<{ kind: "block" | "allow" }>(
    `select kind from cumulus_mail.spam_lists where tenant_id = $1 and address_bidx = $2`,
    [tenantId, listKey(tenantId, address)],
  );
  return rows[0]?.kind ?? null;
}

/** Put the sender on a list. True when this changed something (a new entry, or block <-> allow). */
async function setList(db: MailQuery, tenantId: string, address: string, kind: "block" | "allow"): Promise<boolean> {
  const before = await listKind(db, tenantId, address);
  if (before === kind) return false;
  await db.query(
    `insert into cumulus_mail.spam_lists (tenant_id, address_bidx, kind) values ($1, $2, $3)
     on conflict (tenant_id, address_bidx) do update set kind = excluded.kind, created_at = now()`,
    [tenantId, listKey(tenantId, address), kind],
  );
  return true;
}

/* ---------------- shared reputation ---------------- */

async function bump(db: MailQuery, domain: string, column: "received" | "spam_reports" | "ham_reports"): Promise<void> {
  await db.query(
    `insert into cumulus_mail.sender_reputation (domain, ${column}) values ($1, 1)
     on conflict (domain) do update set ${column} = cumulus_mail.sender_reputation.${column} + 1, updated_at = now()`,
    [domain],
  );
}

export async function reputation(db: MailQuery, domain: string): Promise<{ received: number; spam: number; ham: number }> {
  const rows = await db.query<{ received: number | string; spam_reports: number | string; ham_reports: number | string }>(
    `select received, spam_reports, ham_reports from cumulus_mail.sender_reputation where domain = $1`,
    [domain],
  );
  const row = rows[0];
  return { received: Number(row?.received ?? 0), spam: Number(row?.spam_reports ?? 0), ham: Number(row?.ham_reports ?? 0) };
}

export function badReputation(rep: { spam: number; ham: number }): boolean {
  const reports = rep.spam + rep.ham;
  return reports >= MIN_REPORTS && rep.spam / reports >= SPAM_SHARE;
}

/* ---------------- RBL ---------------- */

/** A-record lookup. Injected so tests use a fixture and production can choose its resolver. */
export type ResolveA = (name: string) => Promise<string[]>;

export function rblZones(env: Record<string, string | undefined> = process.env): string[] {
  return (env.MAIL_RBL_ZONES ?? "")
    .split(",")
    .map((zone) => zone.trim().toLowerCase())
    .filter((zone) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(zone));
}

/**
 * Is the sender's domain listed in any zone? A listing is an answer in 127.0.0.0/8 — except
 * 127.255.255.0/24, which Spamhaus and others return for *errors* (for example a query that came
 * through a public resolver). An error or a timeout counts as not listed: an outage at the RBL must not
 * send everyone's mail to Quarantine.
 */
export async function rblListed(domain: string, zones: string[], resolve: ResolveA, timeoutMs = 2000): Promise<boolean> {
  for (const zone of zones) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const answers = await Promise.race([
        resolve(`${domain}.${zone}`),
        new Promise<string[]>((resolveNone) => {
          timer = setTimeout(() => resolveNone([]), timeoutMs);
        }),
      ]);
      if (answers.some((ip) => /^127\./.test(ip) && !/^127\.255\.255\./.test(ip))) return true;
    } catch {
      // NXDOMAIN (not listed) or a resolver error: not listed.
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return false;
}

/** DNS-over-HTTPS A lookup, for runtimes without a DNS socket (Workers). `MAIL_RBL_DOH_URL` overrides it. */
export function dohResolver(env: Record<string, string | undefined> = process.env, fetcher: typeof fetch = fetch): ResolveA {
  const base = env.MAIL_RBL_DOH_URL?.trim() || "https://cloudflare-dns.com/dns-query";
  return async (name) => {
    const url = `${base}?name=${encodeURIComponent(name)}&type=A`;
    const response = await fetcher(url, { headers: { accept: "application/dns-json" } });
    if (!response.ok) return [];
    const body = (await response.json()) as { Answer?: Array<{ type: number; data: string }> };
    return (body.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data);
  };
}

/* ---------------- the verdict ---------------- */

const passed = (auth?: MailAuth) => Boolean(auth && auth.disposition === "deliver" && (auth.dmarc === "pass" || auth.dkim === "pass" || auth.spf === "pass"));

/**
 * Where an arriving message goes. Also counts it toward the sender domain's `received` total.
 * `auth.disposition === "quarantine"` (DMARC said so) is respected first: no list or reputation
 * overrides the sending domain's own policy.
 */
export async function inboundVerdict(
  db: MailQuery,
  tenantId: string,
  from: string,
  auth: MailAuth | undefined,
  options: { env?: Record<string, string | undefined>; resolve?: ResolveA } = {},
): Promise<SpamVerdict> {
  assertTenantId(tenantId);
  const domain = senderDomain(from);
  if (domain) await bump(db, domain, "received");
  if (auth?.disposition === "quarantine") return { folder: "quarantine", reason: "authentication" };
  const kind = await listKind(db, tenantId, from);
  if (kind === "block") return { folder: "quarantine", reason: "blocklisted" };
  if (kind === "allow" && passed(auth)) return { folder: "inbox", reason: "allowlisted" };
  if (domain && badReputation(await reputation(db, domain))) return { folder: "quarantine", reason: "reputation" };
  const zones = rblZones(options.env ?? process.env);
  if (domain && zones.length && (await rblListed(domain, zones, options.resolve ?? dohResolver(options.env)))) {
    return { folder: "quarantine", reason: "rbl" };
  }
  return { folder: "inbox", reason: "clean" };
}

/* ---------------- what the person does ---------------- */

/*
 * The shared reputation is a vote, so it is guarded: a mailbox's report counts once per sender (pressing
 * Report spam ten times is one vote), and only for a sender that actually mailed it — the caller passes
 * the sender of a message it found in this mailbox, never an address the client typed.
 */

/** "Report spam": block this sender for this mailbox; the first time, count a spam vote for its domain. */
export async function reportSpam(db: MailQuery, tenantId: string, from: string): Promise<void> {
  assertTenantId(tenantId);
  const changed = await setList(db, tenantId, from, "block");
  const domain = senderDomain(from);
  if (changed && domain) await bump(db, domain, "spam_reports");
}

/** "Not spam": allow this sender for this mailbox; the first time, count a "not spam" vote. */
export async function reportNotSpam(db: MailQuery, tenantId: string, from: string): Promise<void> {
  assertTenantId(tenantId);
  const changed = await setList(db, tenantId, from, "allow");
  const domain = senderDomain(from);
  if (changed && domain) await bump(db, domain, "ham_reports");
}

/** The sender of a message in this mailbox, or null. What reportSpam / reportNotSpam are called with. */
export async function messageSender(db: MailQuery, tenantId: string, messageId: string): Promise<string | null> {
  assertTenantId(tenantId);
  const { openText } = await import("./field-crypto.ts");
  const rows = await db.query<{ from_email: string }>(
    `select from_email from cumulus_mail.messages where tenant_id = $1 and id = $2`,
    [tenantId, messageId],
  );
  return rows[0] ? openText(tenantId, rows[0].from_email).trim().toLowerCase() || null : null;
}
