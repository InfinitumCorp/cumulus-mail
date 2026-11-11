import type { DNSResolver } from "./authenticate.ts";
import type { MailSettings } from "./settings.ts";

export async function domainHasTxt(resolver: DNSResolver, name: string, value: string): Promise<boolean> {
  try {
    const rows = await resolver(name, "TXT");
    return rows.some((parts) => (Array.isArray(parts) ? parts.join("") : String(parts)).includes(value));
  } catch {
    return false;
  }
}

export async function refreshDomainVerification(settings: MailSettings, resolver: DNSResolver): Promise<MailSettings> {
  const domains = [];
  for (const domain of settings.domains) {
    const verified = await domainHasTxt(resolver, domain.txtName, domain.txtValue);
    domains.push({ ...domain, verified });
  }
  return { ...settings, domains };
}
