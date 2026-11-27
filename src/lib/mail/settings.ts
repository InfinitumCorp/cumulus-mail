import type { CalEvent, CustomFolder } from "./model.ts";
import { sanitizeFolders } from "./folders.ts";
import { DEFAULT_PLAN, maxLimit, PLANS } from "./plans.ts";
import { validEmail } from "./logic.ts";
import { cleanDomain } from "./routing.ts";
import { DEFAULT_THEME, THEMES, type Theme } from "../theme-names.ts";

export type CustomDomain = {
  domain: string;
  catchAll: boolean;
  verified: boolean;
  txtName: string;
  txtValue: string;
};

export type AutoReply = {
  enabled: boolean;
  subject: string;
  body: string;
  until?: string;
  /** `${email}|YYYY-MM-DD` so one sender gets one reply per day. */
  sent: string[];
};

export type AuditEvent = {
  at: string;
  action: string;
  detail: string;
};

export type Unsubscribed = {
  /** List-Id or sender address, as `subscriptions()` keys it. */
  key: string;
  at: string;
  method: "one-click" | "mailto" | "link";
};

export type MailSettings = {
  undoSendSeconds: number;
  linkConfirmation: boolean;
  blockRemoteImages: boolean;
  autoReply: AutoReply;
  domains: CustomDomain[];
  sieve: string;
  /** User folders shown in the sidebar under the system folders. */
  folders: CustomFolder[];
  events: CalEvent[];
  audit: AuditEvent[];
  /** Lists the owner unsubscribed from, newest last. */
  unsubscribed: Unsubscribed[];
  /** A new mailbox shows "Finish setting up" until its owner completes or dismisses it. */
  setupPending: boolean;
  /** Colour scheme: light (default, the shell as it has always looked), dark, or follow the device. */
  theme: Theme;
  /**
   * This mailbox's OpenPGP key. The private key is passphrase-encrypted armor.
   * The passphrase is never stored. Absent until the owner creates or imports one.
   */
  mailboxKey?: MailboxKey;
  /** Random salt for the client-held search index. Not a secret. */
  indexSalt?: string;
  /** Search index sealed to the mailbox hybrid key. The server cannot read the words. */
  clientIndex?: string;
};

export type HybridMaterial = {
  x25519Public: string;
  mlkemPublic: string;
  /** Passphrase-wrapped X25519 and ML-KEM secrets. The passphrase is not stored. */
  wrappedSecrets: string;
};

export type MailboxKey = {
  publicKey: string;
  privateKey: string;
  fingerprint: string;
  hybrid?: HybridMaterial;
};

export { THEMES, type Theme } from "../theme-names.ts";

export const TXT_VALUE = "cumulus-mail-verify=cumuluscloud.app";

/** Custom domains on the default plan. The server checks the mailbox's own plan (plans.ts). */
export const MAX_DOMAINS = PLANS[DEFAULT_PLAN].domains;

/** Distinct valid custom domains in a settings payload, before any cap is applied. */
export function requestedDomainCount(value: unknown, platformDomain = "cumuluscloud.app"): number {
  const row = value && typeof value === "object" ? (value as Partial<MailSettings>) : {};
  if (!Array.isArray(row.domains)) return 0;
  return new Set(row.domains.map((domain) => asDomain(domain, platformDomain)?.domain).filter(Boolean)).size;
}

export function expectedTxt(domain: string): { name: string; value: string } {
  return { name: `_cumulus-mail.${domain}`, value: TXT_VALUE };
}

export function defaultSettings(): MailSettings {
  return {
    undoSendSeconds: 10,
    linkConfirmation: true,
    blockRemoteImages: true,
    autoReply: { enabled: false, subject: "Away", body: "", sent: [] },
    domains: [],
    sieve: "",
    folders: [],
    events: [],
    audit: [],
    unsubscribed: [],
    setupPending: false,
    theme: DEFAULT_THEME,
  };
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function asDomain(value: unknown, platformDomain: string): CustomDomain | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<CustomDomain>;
  const domain = cleanDomain(text(row.domain, 253), platformDomain);
  if (!domain) return null;
  const txt = expectedTxt(domain);
  return {
    domain,
    catchAll: row.catchAll === true,
    verified: row.verified === true,
    txtName: txt.name,
    txtValue: txt.value,
  };
}

function b64url(value: unknown, min: number, max: number): string {
  const textValue = text(value, max);
  return /^[A-Za-z0-9_-]+$/.test(textValue) && textValue.length >= min ? textValue : "";
}

function asHybrid(value: unknown): HybridMaterial | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Partial<HybridMaterial>;
  const x25519Public = b64url(row.x25519Public, 40, 50);
  const mlkemPublic = b64url(row.mlkemPublic, 1500, 1700);
  // New wraps carry a "w2." version prefix (see pqc.ts); older ones are bare base64url.
  const rawWrap = typeof row.wrappedSecrets === "string" ? row.wrappedSecrets : "";
  const wrapPrefix = rawWrap.startsWith("w2.") ? "w2." : "";
  const wrapBody = b64url(rawWrap.slice(wrapPrefix.length), 40, 8000);
  const wrappedSecrets = wrapBody ? wrapPrefix + wrapBody : "";
  if (!x25519Public || !mlkemPublic || !wrappedSecrets) return undefined;
  return { x25519Public, mlkemPublic, wrappedSecrets };
}

function asMailboxKey(value: unknown): MailboxKey | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Partial<MailboxKey> & { passphrase?: unknown };
  if ("passphrase" in row && row.passphrase) return undefined;
  const publicKey = text(row.publicKey, 20_000).trim();
  const privateKey = text(row.privateKey, 30_000).trim();
  if (!publicKey.includes("-----BEGIN PGP PUBLIC KEY BLOCK-----")) return undefined;
  if (!privateKey.includes("-----BEGIN PGP PRIVATE KEY BLOCK-----")) return undefined;
  if (publicKey.includes("BEGIN PGP PRIVATE KEY")) return undefined;
  const fingerprint = text(row.fingerprint, 64).toLowerCase();
  const hybrid = asHybrid((row as { hybrid?: unknown }).hybrid);
  return {
    publicKey,
    privateKey,
    fingerprint: /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(fingerprint) ? fingerprint : "",
    ...(hybrid ? { hybrid } : {}),
  };
}

function asEvent(value: unknown): CalEvent | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<CalEvent>;
  if (typeof row.id !== "string" || typeof row.title !== "string") return null;
  return {
    id: row.id.slice(0, 80),
    title: row.title.slice(0, 200),
    whenLabel: text(row.whenLabel, 120),
    where: text(row.where, 200),
    with: text(row.with, 200),
    sort: text(row.sort, 40),
    ...(typeof row.rrule === "string" && row.rrule ? { rrule: row.rrule.slice(0, 300) } : {}),
    ...(Array.isArray(row.exdates)
      ? { exdates: row.exdates.filter((item): item is string => typeof item === "string" && Number.isFinite(Date.parse(item))).slice(0, 100) }
      : {}),
    ...(Array.isArray(row.rdates)
      ? { rdates: row.rdates.filter((item): item is string => typeof item === "string" && Number.isFinite(Date.parse(item))).slice(0, 100) }
      : {}),
    ...(typeof row.uid === "string" && row.uid ? { uid: row.uid.slice(0, 300) } : {}),
    ...(typeof row.organizer === "string" && validEmail(row.organizer) ? { organizer: row.organizer.toLowerCase().slice(0, 320) } : {}),
    ...(row.rsvp === "accepted" || row.rsvp === "tentative" || row.rsvp === "declined" ? { rsvp: row.rsvp } : {}),
  };
}

/** Drop anything the client is not allowed to invent. Verified stays as given here; the mailbox writer keeps the stored flag. */
export function sanitizeSettings(value: unknown, platformDomain = "cumuluscloud.app"): MailSettings {
  const base = defaultSettings();
  if (!value || typeof value !== "object") return base;
  const row = value as Partial<MailSettings>;
  const undo = Number(row.undoSendSeconds);
  const auto = row.autoReply;
  const domains = Array.isArray(row.domains)
    ? row.domains.map((domain) => asDomain(domain, platformDomain)).filter((domain): domain is CustomDomain => Boolean(domain)).slice(0, maxLimit("domains"))
    : [];
  const seen = new Set<string>();
  return {
    undoSendSeconds: Number.isFinite(undo) ? Math.max(0, Math.min(30, Math.trunc(undo))) : base.undoSendSeconds,
    linkConfirmation: row.linkConfirmation !== false,
    blockRemoteImages: row.blockRemoteImages !== false,
    autoReply: {
      enabled: Boolean(auto && typeof auto === "object" && auto.enabled),
      subject: text(auto && typeof auto === "object" ? auto.subject : "", 200) || "Away",
      body: text(auto && typeof auto === "object" ? auto.body : "", 4000),
      until: auto && typeof auto === "object" && typeof auto.until === "string" ? auto.until.slice(0, 40) : undefined,
      sent: Array.isArray(auto && typeof auto === "object" ? auto.sent : null)
        ? (auto as AutoReply).sent.filter((item) => typeof item === "string").map((item) => item.slice(0, 360)).slice(-200)
        : [],
    },
    domains: domains.filter((domain) => {
      if (seen.has(domain.domain)) return false;
      seen.add(domain.domain);
      return true;
    }),
    sieve: text(row.sieve, 8000),
    folders: sanitizeFolders(row.folders),
    events: Array.isArray(row.events) ? row.events.map(asEvent).filter((event): event is CalEvent => Boolean(event)).slice(0, 50) : [],
    audit: Array.isArray(row.audit)
      ? row.audit
          .filter((item): item is AuditEvent => Boolean(item) && typeof item === "object" && typeof (item as AuditEvent).action === "string")
          .map((item) => ({
            at: text(item.at, 40),
            action: text(item.action, 80),
            detail: text(item.detail, 300),
          }))
          .slice(-40)
      : [],
    unsubscribed: Array.isArray(row.unsubscribed)
      ? row.unsubscribed
          .filter(
            (item): item is Unsubscribed =>
              Boolean(item) &&
              typeof item === "object" &&
              typeof (item as Unsubscribed).key === "string" &&
              ["one-click", "mailto", "link"].includes((item as Unsubscribed).method),
          )
          .map((item) => ({ key: text(item.key, 320).toLowerCase(), at: text(item.at, 40), method: item.method }))
          .slice(-200)
      : [],
    setupPending: row.setupPending === true,
    theme: THEMES.includes(row.theme as Theme) ? (row.theme as Theme) : DEFAULT_THEME,
    ...(asMailboxKey(row.mailboxKey) ? { mailboxKey: asMailboxKey(row.mailboxKey) } : {}),
    ...(b64url(row.indexSalt, 16, 64) ? { indexSalt: b64url(row.indexSalt, 16, 64) } : {}),
    ...(typeof row.clientIndex === "string" && row.clientIndex.startsWith("cmh1.") && row.clientIndex.length < 120_000
      ? { clientIndex: row.clientIndex }
      : {}),
  };
}

export function noteUnsubscribed(
  settings: MailSettings,
  key: string,
  method: Unsubscribed["method"],
  now = new Date(),
): MailSettings {
  const clean = key.trim().toLowerCase();
  return {
    ...settings,
    unsubscribed: [...settings.unsubscribed.filter((item) => item.key !== clean), { key: clean, at: now.toISOString(), method }].slice(-200),
  };
}

export function addressAllowed(email: string, settings: MailSettings, platformDomain: string): string | null {
  const normalized = email.trim().toLowerCase();
  if (!validEmail(normalized)) return "Enter a real address.";
  const domain = normalized.split("@")[1] ?? "";
  if (domain === platformDomain) return null;
  if (settings.domains.some((item) => item.domain === domain && item.verified)) return null;
  return "That domain is not verified yet.";
}

export function dayKey(email: string, now: Date): string {
  return `${email.trim().toLowerCase()}|${now.toISOString().slice(0, 10)}`;
}

export function autoReplyActive(settings: MailSettings, now = new Date()): boolean {
  if (!settings.autoReply.enabled || !settings.autoReply.body.trim()) return false;
  if (!settings.autoReply.until) return true;
  const until = Date.parse(settings.autoReply.until);
  return !Number.isFinite(until) || until > now.getTime();
}

export function shouldAutoReply(settings: MailSettings, fromEmail: string, now = new Date()): boolean {
  if (!autoReplyActive(settings, now)) return false;
  return !settings.autoReply.sent.includes(dayKey(fromEmail, now));
}

export function noteAutoReply(settings: MailSettings, fromEmail: string, now = new Date()): MailSettings {
  const key = dayKey(fromEmail, now);
  if (settings.autoReply.sent.includes(key)) return settings;
  return {
    ...settings,
    autoReply: { ...settings.autoReply, sent: [...settings.autoReply.sent, key].slice(-200) },
  };
}

/**
 * Notes the SERVER adds to settings while a tab is open (src/lib/mail/delivery.ts records each auto-reply
 * sent; src/lib/mail/unsubscribe.ts records one-click unsubscribes). A save carries the tab's copy of
 * settings, which may predate them; the app only ever adds to these lists, never removes, so the stored
 * entries are kept (union). Without this, a stale tab's save erased them: a sender could get a second
 * auto-reply the same day, and an unsubscribe would show as not done.
 */
export function keepServerNotes(previous: MailSettings, next: MailSettings): MailSettings {
  const sent = [...new Set([...previous.autoReply.sent, ...next.autoReply.sent])].slice(-200);
  const byKey = new Map<string, Unsubscribed>();
  for (const item of [...previous.unsubscribed, ...next.unsubscribed]) {
    const prior = byKey.get(item.key);
    if (!prior || item.at > prior.at) byKey.set(item.key, item);
  }
  const unsubscribed = [...byKey.values()].sort((a, b) => (a.at < b.at ? -1 : 1)).slice(-200);
  return { ...next, autoReply: { ...next.autoReply, sent }, unsubscribed };
}

/** A domain stays verified only when the stored row already was, and its TXT value did not change. */
export function keepVerified(previous: MailSettings, next: MailSettings): MailSettings {
  return {
    ...next,
    domains: next.domains.map((domain) => {
      const prior = previous.domains.find((item) => item.domain === domain.domain && item.txtValue === domain.txtValue);
      return { ...domain, verified: prior?.verified === true };
    }),
  };
}

export function recordAudit(settings: MailSettings, action: string, detail: string, now = new Date()): MailSettings {
  return sanitizeSettings({
    ...settings,
    audit: [...settings.audit, { at: now.toISOString(), action, detail }],
  });
}
