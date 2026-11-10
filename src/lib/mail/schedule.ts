import { isDriveShareHref } from "./cloud-link.ts";
import type { MailMessage, MessageExtra } from "./model.ts";

export function sanitizeExtra(extra: MessageExtra | undefined): MessageExtra | undefined {
  if (!extra) return undefined;
  const next: MessageExtra = {};
  if (extra.scheduleAt && Number.isFinite(Date.parse(extra.scheduleAt))) next.scheduleAt = extra.scheduleAt;
  if (extra.heldUntil && Number.isFinite(Date.parse(extra.heldUntil))) next.heldUntil = extra.heldUntil;
  if (extra.protection && typeof extra.protection.ciphertext === "string" && typeof extra.protection.expiresAt === "string") {
    next.protection = {
      salt: extra.protection.salt.slice(0, 80),
      iv: extra.protection.iv.slice(0, 40),
      ciphertext: extra.protection.ciphertext.slice(0, 200_000),
      expiresAt: extra.protection.expiresAt.slice(0, 40),
      readsLeft: Math.max(0, Math.min(100, Math.trunc(extra.protection.readsLeft))),
      selfDestruct: extra.protection.selfDestruct === true,
      iterations: Math.max(1_000, Math.min(200_000, Math.trunc(extra.protection.iterations) || 20_000)),
    };
  }
  if (extra.readReceipt === "requested" || extra.readReceipt === "accepted" || extra.readReceipt === "declined") {
    next.readReceipt = extra.readReceipt;
  }
  if (extra.pgp) next.pgp = true;
  if (extra.autoReply) next.autoReply = true;
  const links = (extra.cloudLinks ?? []).filter((link) => isDriveShareHref(link.href)).slice(0, 8);
  if (links.length) {
    next.cloudLinks = links.map((link) => ({
      name: link.name.slice(0, 180),
      size: Math.max(0, Math.trunc(link.size)),
      href: link.href,
      expiresAt: link.expiresAt.slice(0, 40),
    }));
  }
  return Object.keys(next).length ? next : undefined;
}

function cleanExtra(extra: MessageExtra): MessageExtra | undefined {
  const next: MessageExtra = {};
  if (extra.scheduleAt) next.scheduleAt = extra.scheduleAt;
  if (extra.heldUntil) next.heldUntil = extra.heldUntil;
  if (extra.protection) next.protection = extra.protection;
  if (extra.readReceipt) next.readReceipt = extra.readReceipt;
  if (extra.pgp) next.pgp = true;
  if (extra.autoReply) next.autoReply = true;
  if (extra.cloudLinks?.length) next.cloudLinks = extra.cloudLinks;
  return Object.keys(next).length ? next : undefined;
}

function due(value: string | undefined, now: number): boolean {
  if (!value) return false;
  const at = Date.parse(value);
  return Number.isFinite(at) && at <= now;
}

/** Move a scheduled draft to Sent, and drop an undo hold, once their time has passed. */
export function releaseDue(messages: MailMessage[], now = Date.now()): MailMessage[] {
  let changed = false;
  const next = messages.map((message) => {
    const extra = message.extra;
    if (!extra) return message;
    const scheduleDue = message.folder === "drafts" && due(extra.scheduleAt, now);
    const holdDue = due(extra.heldUntil, now);
    if (!scheduleDue && !holdDue) return message;
    changed = true;
    const updated: MessageExtra = {
      ...extra,
      scheduleAt: scheduleDue ? undefined : extra.scheduleAt,
      heldUntil: holdDue ? undefined : extra.heldUntil,
    };
    return {
      ...message,
      folder: scheduleDue ? "sent" : message.folder,
      extra: cleanExtra(updated),
    };
  });
  return changed ? next : messages;
}

export function isHeld(message: MailMessage, now = Date.now()): boolean {
  const until = message.extra?.heldUntil;
  if (!until) return false;
  const at = Date.parse(until);
  return Number.isFinite(at) && at > now;
}
