/** Plus-addressing and catch-all helpers. They do not query DNS or the network. */

export function stripPlus(address: string): string {
  const email = address.trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at <= 0) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus <= 0) return email;
  return `${local.slice(0, plus)}@${domain}`;
}

export function catchAllAddress(domain: string): string {
  return `*@${domain.trim().toLowerCase()}`;
}

export function cleanDomain(value: string, platformDomain: string): string | null {
  const domain = value.trim().toLowerCase().replace(/\.+$/g, "");
  if (!domain || domain === platformDomain.trim().toLowerCase()) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)) {
    return null;
  }
  return domain;
}
