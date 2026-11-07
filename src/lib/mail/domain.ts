/**
 * Sample mailbox domain for this local demo.
 * An exact host match is only a label. It does not encrypt, deliver, or trust a tenant.
 */
export const SAMPLE_MAIL_DOMAIN = "cumuluscloud.app";

/**
 * Proposed service hostnames. DNS for these names is not verified here.
 * They are not trusted origins, not cookie domains, and not configured in this app.
 * Local development stays on loopback. Cloud and Drive auth live in another codebase.
 */
export const PROPOSED_SERVICE_HOSTS = {
  id: "id.cumuluscloud.app",
  cloud: "cloud.cumuluscloud.app",
  mail: "mail.cumuluscloud.app",
} as const;

/** True when the address host is exactly the sample mailbox domain. */
export function usesSampleMailDomain(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at <= 0) return false;
  return email.slice(at + 1).trim().toLowerCase() === SAMPLE_MAIL_DOMAIN;
}
