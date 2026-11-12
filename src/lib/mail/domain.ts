/** Default mailbox domain. Override with MAIL_DOMAIN or VITE_MAIL_DOMAIN. */
export const DEFAULT_MAIL_DOMAIN = "cumuluscloud.app";

/** Default web host for the mail app. Override with MAIL_APP_HOST or VITE_MAIL_APP_HOST. */
export const DEFAULT_MAIL_APP_HOST = "mail.cumuluscloud.app";

type EnvName = "MAIL_DOMAIN" | "MAIL_APP_HOST";

/**
 * Vite's env, read with fixed names only. Vite replaces `import.meta.env.NAME` at build time and its dev
 * SSR runner refuses computed access (`import.meta.env[name]`), which used to throw in `npm run dev`.
 * Plain Node (tests, scripts) has no `import.meta.env`, hence the try.
 */
function viteEnv(name: EnvName): string | undefined {
  try {
    const values: Record<EnvName, Array<string | undefined>> = {
      MAIL_DOMAIN: [import.meta.env.MAIL_DOMAIN, import.meta.env.VITE_MAIL_DOMAIN],
      MAIL_APP_HOST: [import.meta.env.MAIL_APP_HOST, import.meta.env.VITE_MAIL_APP_HOST],
    };
    return values[name].map((value) => (typeof value === "string" ? value.trim() : "")).find(Boolean);
  } catch {
    return undefined;
  }
}

function envValue(name: EnvName): string | undefined {
  const fromProcess = typeof process !== "undefined" ? process.env?.[name]?.trim() : undefined;
  if (fromProcess) return fromProcess;
  return viteEnv(name);
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
