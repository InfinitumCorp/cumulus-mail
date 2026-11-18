import { createHash } from "node:crypto";
import type { MailSettings } from "./settings.ts";

/**
 * The TXT record that proves a custom domain belongs to this mailbox: derived from the mailbox (tenant) and the
 * domain on the server, so one mailbox's published record never verifies the same domain for another mailbox, and
 * nothing a client sends can change it. (TXT records are public, so a value the client chose could be copied.)
 */
export function ownershipTxt(tenantId: string, domain: string): { name: string; value: string } {
  const digest = createHash("sha256").update(`cumulus-mail-domain:${tenantId}:${domain.toLowerCase()}`).digest("hex");
  return { name: `_cumulus-mail.${domain.toLowerCase()}`, value: `cumulus-mail-verify=${digest.slice(0, 32)}` };
}

/** Every domain row with this mailbox's own TXT name and value (server side, on every read and write). */
export function withOwnershipTxt(tenantId: string, settings: MailSettings): MailSettings {
  return {
    ...settings,
    domains: settings.domains.map((d) => {
      const txt = ownershipTxt(tenantId, d.domain);
      return { ...d, txtName: txt.name, txtValue: txt.value };
    }),
  };
}
