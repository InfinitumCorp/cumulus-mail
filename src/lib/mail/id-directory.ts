/**
 * Cumulus://ID key directory contract.
 *
 * The identity service (not this repo) should host:
 *   GET  {CID_KEYS_URL}/{email}          -> text/plain armored public key, or 404
 *   PUT  {CID_KEYS_URL}/{email}          Authorization: Bearer <Cumulus ID access token>
 *                                        body: the armored public key
 *                                        204 when the token's email matches {email}
 *
 * Default base: https://id.cumuluscloud.app/api/keys
 * Override with CID_KEYS_URL. A miss or a network error never blocks sending.
 * See docs/cumulus-id-keys.md.
 */

const DEFAULT_BASE = "https://id.cumuluscloud.app/api/keys";

export function keysBase(env: Record<string, string | undefined> = process.env): string {
  return (env.CID_KEYS_URL?.trim() || DEFAULT_BASE).replace(/\/$/, "");
}

export function keyUrl(email: string, env?: Record<string, string | undefined>): string | null {
  const normalized = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) return null;
  return `${keysBase(env)}/${encodeURIComponent(normalized)}`;
}

export async function lookupDirectoryKey(
  email: string,
  fetcher: typeof fetch = fetch,
  env?: Record<string, string | undefined>,
): Promise<string | null> {
  const url = keyUrl(email, env);
  if (!url) return null;
  try {
    const response = await fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(4000) });
    if (!response.ok) return null;
    const text = await response.text();
    return text.includes("BEGIN PGP PUBLIC KEY BLOCK") ? text.slice(0, 20_000) : null;
  } catch {
    return null;
  }
}

export async function publishDirectoryKey(
  email: string,
  publicKey: string,
  token: string,
  fetcher: typeof fetch = fetch,
  env?: Record<string, string | undefined>,
): Promise<boolean> {
  const url = keyUrl(email, env);
  if (!url || !token || !publicKey.includes("BEGIN PGP PUBLIC KEY BLOCK")) return false;
  try {
    const response = await fetcher(url, {
      method: "PUT",
      redirect: "manual",
      signal: AbortSignal.timeout(4000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/pgp-keys" },
      body: publicKey,
    });
    return response.ok || response.status === 204;
  } catch {
    return false;
  }
}
