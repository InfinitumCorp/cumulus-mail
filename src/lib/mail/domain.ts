/** Default mailbox domain. Override with MAIL_DOMAIN or VITE_MAIL_DOMAIN. */
export const DEFAULT_MAIL_DOMAIN = "cumuluscloud.app";

/** Default web host for the mail app. Override with MAIL_APP_HOST or VITE_MAIL_APP_HOST. */
export const DEFAULT_MAIL_APP_HOST = "mail.cumuluscloud.app";

function envValue(name: string): string | undefined {
  const fromProcess = typeof process !== "undefined" ? process.env?.[name]?.trim() : undefined;
  if (fromProcess) return fromProcess;
  const meta = import.meta as { env?: Record<string, string | undefined> };
  return meta.env?.[name]?.trim() || meta.env?.[`VITE_${name}`]?.trim() || undefined;
}

function hostName(value: string, fallback: string): string {
  const cleaned = value.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(cleaned)) {
    return fallback;
  }
  return cleaned;
}

export function mailDomain(): string {
  return hostName(envValue("MAIL_DOMAIN") ?? DEFAULT_MAIL_DOMAIN, DEFAULT_MAIL_DOMAIN);
}

export function mailAppHost(): string {
  return hostName(envValue("MAIL_APP_HOST") ?? DEFAULT_MAIL_APP_HOST, DEFAULT_MAIL_APP_HOST);
}

export function mailboxAddress(localPart: string, domain = mailDomain()): string {
  return `${localPart}@${domain}`;
}
