/**
 * The address a new mailbox gets. People sign in with Google, so the sign-in email is usually on
 * another domain (gmail.com, a company domain). A mailbox can only receive mail on this service's
 * domain, so a new mailbox gets `<local part>@<MAIL_DOMAIN>`, built from the sign-in email's local part
 * and made unique, rather than the Google address itself. Existing mailboxes keep their stored address.
 */
import { addressOwnedByOther } from "./directory.ts";
import { mailDomain } from "./domain.ts";
import type { MailQuery } from "./query.ts";

const RESERVED = new Set([
  "abuse", "admin", "administrator", "billing", "contact", "help", "hostmaster", "info", "mailer-daemon",
  "noc", "no-reply", "noreply", "postmaster", "root", "security", "support", "webmaster",
]);

/** `Ada.Lovelace+news@gmail.com` -> `ada.lovelace`. Empty when nothing usable is left. */
export function localPartFrom(signInEmail: string | null | undefined): string {
  const local = (signInEmail ?? "").trim().toLowerCase().split("@")[0]?.split("+")[0] ?? "";
  const cleaned = local
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/[._-]{2,}/g, ".")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 40)
    .replace(/[._-]+$/g, "");
  return cleaned.length >= 3 && !RESERVED.has(cleaned) ? cleaned : "";
}

/**
 * Pick a free address on the mail domain for a tenant that has no mailbox yet. Tries the sign-in
 * local part, then `<local>2`, `<local>3`, ..., and falls back to an address from the tenant id.
 */
export async function chooseMailboxAddress(
  db: MailQuery,
  tenantId: string,
  signInEmail: string | null | undefined,
  domain = mailDomain(),
): Promise<string> {
  const fallback = `u${tenantId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16)}@${domain}`;
  const base = localPartFrom(signInEmail);
  if (!base) return fallback;
  for (let n = 1; n <= 20; n += 1) {
    const candidate = `${n === 1 ? base : `${base}${n}`}@${domain}`;
    if (!(await addressOwnedByOther(db, candidate, tenantId))) return candidate;
  }
  return fallback;
}
