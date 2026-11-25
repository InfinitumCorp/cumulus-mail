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
import { mailDomain } from "./domain.ts";
import { assertTenantId } from "../storage/adapter.ts";
import { blindIndex } from "./field-crypto.ts";
import type { MailAuth } from "./model.ts";
import type { MailQuery } from "./query.ts";

export type SpamVerdict =
  | { folder: "inbox"; reason: "allowlisted" | "clean" }
  | { folder: "quarantine"; reason: "blocklisted" | "reputation" | "rbl" | "authentication" | "own-domain" | "feed" };

/**
 * A domain needs this many votes before its reputation counts. A vote is one mailbox's verdict on one
 * domain (spam_votes), so this is the number of different mailboxes, and one person cannot sink a domain.
 */
export const MIN_REPORTS = 5;
/** And this share of its votes must be "spam" rather than "not spam". */
export const SPAM_SHARE = 0.8;
/**
 * And the spam votes must be at least this share of the mail received from the domain, so a big
 * provider (thousands of messages a day) is not sunk by the same handful of votes as a tiny sender.
 */
export const RECEIVED_SHARE = 0.001;

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

async function bump(
  db: MailQuery,
  domain: string,
  column: "received" | "spam_reports" | "ham_reports",
  by = 1,
): Promise<void> {
  await db.query(
    `insert into cumulus_mail.sender_reputation (domain, ${column}) values ($1, $2)
     on conflict (domain) do update set ${column} = cumulus_mail.sender_reputation.${column} + $2, updated_at = now()`,
    [domain, by],
  );
}

/**
 * `received` for a big sending domain is one row that every authenticated message from it would update,
 * so under load every inbound message from that domain queues on the same row lock. Past
 * RECEIVED_SAMPLE_FROM it is counted by sampling: one message in RECEIVED_SAMPLE (at random) adds
 * RECEIVED_SAMPLE. The expected count is unchanged and the row takes about 1/16 of the writes; the count
 * is only compared against spam votes at 0.1% (RECEIVED_SHARE), far coarser than the sampling noise.
 */
export const RECEIVED_SAMPLE_FROM = 1000;
export const RECEIVED_SAMPLE = 16;

export async function countReceived(
  db: MailQuery,
  domain: string,
  current: number,
  random: () => number = Math.random,
): Promise<void> {
  if (current < RECEIVED_SAMPLE_FROM) return bump(db, domain, "received");
  if (random() < 1 / RECEIVED_SAMPLE) await bump(db, domain, "received", RECEIVED_SAMPLE);
}

export async function reputation(db: MailQuery, domain: string): Promise<{ received: number; spam: number; ham: number }> {
  const rows = await db.query<{ received: number | string; spam_reports: number | string; ham_reports: number | string }>(
    `select received, spam_reports, ham_reports from cumulus_mail.sender_reputation where domain = $1`,
    [domain],
  );
  const row = rows[0];
  return { received: Number(row?.received ?? 0), spam: Number(row?.spam_reports ?? 0), ham: Number(row?.ham_reports ?? 0) };
}

export function badReputation(rep: { spam: number; ham: number; received?: number }): boolean {
  const reports = rep.spam + rep.ham;
  return reports >= MIN_REPORTS && rep.spam / reports >= SPAM_SHARE && rep.spam >= (rep.received ?? 0) * RECEIVED_SHARE;
}

/** Did this message authenticate as its From: domain? Only such mail can vote on that domain's reputation. */
export function authenticatedForDomain(auth?: MailAuth): boolean {
  return auth?.dmarc === "pass";
}

/**
 * Record one mailbox's vote on a domain. At most one vote per mailbox per domain: the same vote again
 * changes nothing, and a different one moves it (spam -> ham takes one off spam and adds one to ham).
 */
async function vote(db: MailQuery, tenantId: string, domain: string, kind: "spam" | "ham"): Promise<void> {
  const voter = blindIndex(tenantId, "spam-vote", domain);
  const rows = await db.query<{ kind: "spam" | "ham" }>(
    `select kind from cumulus_mail.spam_votes where domain = $1 and voter = $2`,
    [domain, voter],
  );
  const before = rows[0]?.kind;
  if (before === kind) return;
  await db.query(
    `insert into cumulus_mail.spam_votes (domain, voter, kind) values ($1, $2, $3)
     on conflict (domain, voter) do update set kind = excluded.kind, updated_at = now()`,
    [domain, voter, kind],
  );
  await bump(db, domain, kind === "spam" ? "spam_reports" : "ham_reports");
  if (before) {
    const column = before === "spam" ? "spam_reports" : "ham_reports";
    await db.query(
      `update cumulus_mail.sender_reputation set ${column} = greatest(${column} - 1, 0), updated_at = now() where domain = $1`,
      [domain],
    );
  }
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
 * Where an arriving message goes. Also counts it toward the sender domain's `received` total when it
 * authenticated as that domain.
 * `auth.disposition === "quarantine"` (DMARC said so) is respected first: no list or reputation
 * overrides the sending domain's own policy.
 */
export async function inboundVerdict(
  db: MailQuery,
  tenantId: string,
  from: string,
  auth: MailAuth | undefined,
  options: { env?: Record<string, string | undefined>; resolve?: ResolveA; random?: () => number; feedDomains?: Set<string> } = {},
): Promise<SpamVerdict> {
  assertTenantId(tenantId);
  const domain = senderDomain(from);
  // One read of the domain's counters, used for counting and for the verdict.
  let rep: Awaited<ReturnType<typeof reputation>> | null = null;
  const repOf = async (name: string) => (rep ??= await reputation(db, name));
  // Only mail that authenticated as the domain counts toward its volume, like votes: forged mail must not
  // be able to pad a domain's `received` count and so dilute its spam votes (RECEIVED_SHARE).
  if (domain && authenticatedForDomain(auth)) {
    await countReceived(db, domain, (await repOf(domain)).received, options.random);
  }
  if (auth?.disposition === "quarantine") return { folder: "quarantine", reason: "authentication" };
  // Mail between Cumulus mailboxes is delivered inside the app and never arrives here, so mail from the
  // OUTSIDE claiming the platform's own domain is forged ("support@", a colleague) unless it passes DMARC
  // for that domain (our own signed mail relayed by a list does, once MAIL_AUTH_DNS=live). No list or
  // allowlist overrides this. A person's custom domains are theirs to send from anywhere, so not these.
  if (domain && domain === mailDomain().toLowerCase() && auth?.dmarc !== "pass") {
    return { folder: "quarantine", reason: "own-domain" };
  }
  const kind = await listKind(db, tenantId, from);
  if (kind === "block") return { folder: "quarantine", reason: "blocklisted" };
  if (kind === "allow" && passed(auth)) return { folder: "inbox", reason: "allowlisted" };
  // After the person's own lists: a feed like URLhaus lists compromised but legitimate hosts (and their
  // parent domains), and someone who allowlisted a correspondent there must still get their mail when
  // it authenticates.
  if (options.feedDomains && domain && (await import("./spam-feed.ts")).listedDomain(options.feedDomains, from)) {
    return { folder: "quarantine", reason: "feed" };
  }
  if (domain && badReputation(await repOf(domain))) return { folder: "quarantine", reason: "reputation" };
  const zones = rblZones(options.env ?? process.env);
  if (domain && zones.length && (await rblListed(domain, zones, options.resolve ?? dohResolver(options.env)))) {
    return { folder: "quarantine", reason: "rbl" };
  }
  return { folder: "inbox", reason: "clean" };
}

/* ---------------- what the person does ---------------- */

/*
 * The shared reputation is a vote, so it is guarded:
 *   - one vote per mailbox per DOMAIN (spam_votes): reporting five addresses at one domain, or pressing
 *     Report spam ten times, is still one vote;
 *   - only for mail that passed DMARC for that domain, so forged mail ("From: someone@bigprovider") can
 *     neither sink the real domain nor be used to sink it on purpose;
 *   - only for a sender that actually mailed this mailbox: the caller passes the sender and the stored
 *     authentication result of a message it found here, never an address the client typed.
 * The mailbox's own block / allow list is set either way: that only affects this mailbox.
 */

/**
 * Block this sender for this mailbox only. Unlike report spam, this does not vote on the
 * domain's shared reputation, so one person cannot sink a domain by blocking a correspondent.
 */
export async function blockSender(db: MailQuery, tenantId: string, from: string): Promise<void> {
  assertTenantId(tenantId);
  await setList(db, tenantId, from, "block");
}

/** "Report spam": block this sender for this mailbox, and vote "spam" for its domain if the mail authenticated. */
export async function reportSpam(db: MailQuery, tenantId: string, from: string, auth?: MailAuth): Promise<void> {
  assertTenantId(tenantId);
  await setList(db, tenantId, from, "block");
  const domain = senderDomain(from);
  if (domain && authenticatedForDomain(auth)) await vote(db, tenantId, domain, "spam");
}

/** "Not spam": allow this sender for this mailbox, and vote "not spam" for its domain if the mail authenticated. */
export async function reportNotSpam(db: MailQuery, tenantId: string, from: string, auth?: MailAuth): Promise<void> {
  assertTenantId(tenantId);
  await setList(db, tenantId, from, "allow");
  const domain = senderDomain(from);
  if (domain && authenticatedForDomain(auth)) await vote(db, tenantId, domain, "ham");
}

/** The sender of a message in this mailbox, or null. */
export async function messageSender(db: MailQuery, tenantId: string, messageId: string): Promise<string | null> {
  return (await reportedMessage(db, tenantId, messageId))?.from ?? null;
}

/** The sender and the stored authentication result of a message in this mailbox: what a report is made from. */
export async function reportedMessage(
  db: MailQuery,
  tenantId: string,
  messageId: string,
): Promise<{ from: string; auth?: MailAuth } | null> {
  assertTenantId(tenantId);
  const { openText } = await import("./field-crypto.ts");
  const rows = await db.query<{ from_email: string; auth_json: string | null }>(
    `select from_email, auth_json from cumulus_mail.messages where tenant_id = $1 and id = $2`,
    [tenantId, messageId],
  );
  const row = rows[0];
  if (!row) return null;
  const from = openText(tenantId, row.from_email).trim().toLowerCase();
  if (!from) return null;
  let auth: MailAuth | undefined;
  try {
    auth = row.auth_json ? (JSON.parse(openText(tenantId, row.auth_json)) as MailAuth) : undefined;
  } catch {
    auth = undefined;
  }
  return { from, auth };
}
