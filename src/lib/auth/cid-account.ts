/**
 * Cumulus://ID account APIs that Mail calls with the person's own access token
 * (the one Better Auth stored after sign-in):
 *
 *   GET    <CID_ISSUER>/api/id/sessions                 -> { sessions: [...] }
 *   DELETE <CID_ISSUER>/api/id/sessions/:id             -> { ok: true }
 *   POST   <CID_ISSUER>/api/id/sessions/revoke-others   -> { ended: n }
 *   GET    <CID_ISSUER>/api/id/keys?address=            -> { keys: [...] }   (public)
 *   POST   <CID_ISSUER>/api/id/keys { armored }         -> { key: {...} }
 *   DELETE <CID_ISSUER>/api/id/keys/:id                 -> { ok: true }
 *
 * Dependency-free so it can be tested without a server. A token that is
 * missing, expired or revoked never becomes an exception for the caller: it is
 * `{ status: "signed-out" }`, and the UI links to the account page instead.
 */

/** Passkeys, the authenticator app, recovery codes and every session live here. */
export const CUMULUS_ID_ACCOUNT_URL = "https://id.cumuluscloud.app/account";

export type CidSession = {
  id: string;
  kind: "console" | "app";
  /** Product name for an app session (Cumulus://Mail, …); null for the ID console. */
  client: string | null;
  method: string;
  device: string;
  country: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
};

export type CidResult<T> =
  | { status: "ok"; value: T }
  | { status: "signed-out"; accountUrl: string }
  | { status: "error"; message: string };

export type PublishedKey = { id: string; address: string; fingerprint: string; createdAt: string };
export type DirectoryKey = { address: string; fingerprint: string; armored: string };

type CidCall = {
  issuer: string;
  /** Null or expired: the call is not made. */
  accessToken: string | null;
  accessTokenExpiresAt?: Date | null;
  fetch?: typeof fetch;
  now?: number;
};

const SIGNED_OUT = { status: "signed-out", accountUrl: CUMULUS_ID_ACCOUNT_URL } as const;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

const text = (value: unknown, max = 200) => (typeof value === "string" ? value.slice(0, max) : "");

/** Token presence and expiry, with a few seconds of slack for the round trip. */
export function tokenUsable(accessToken: string | null, expiresAt?: Date | null, now = Date.now()): boolean {
  if (!accessToken) return false;
  if (expiresAt && expiresAt.getTime() - now < 5_000) return false;
  return true;
}

async function callCid(
  call: CidCall,
  path: string,
  init: { method: "GET" | "POST" | "DELETE"; body?: unknown },
): Promise<CidResult<Record<string, unknown>>> {
  if (!tokenUsable(call.accessToken, call.accessTokenExpiresAt, call.now)) return SIGNED_OUT;
  const get = call.fetch ?? fetch;
  let res: Response;
  try {
    res = await get(`${call.issuer.replace(/\/+$/, "")}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${call.accessToken}`,
        accept: "application/json",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { status: "error", message: "Cumulus://ID could not be reached. Try again." };
  }
  if (res.status === 401) return SIGNED_OUT;
  const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    return { status: "error", message: text(out.error_description) || `Cumulus://ID answered HTTP ${res.status}.` };
  }
  return { status: "ok", value: out };
}

function asSession(value: unknown): CidSession | null {
  if (!value || typeof value !== "object") return null;
  const s = value as Record<string, unknown>;
  if (typeof s.id !== "string" || !SAFE_ID.test(s.id)) return null;
  const client = s.client && typeof s.client === "object" ? (s.client as Record<string, unknown>) : null;
  return {
    id: s.id,
    kind: s.kind === "app" ? "app" : "console",
    client: client ? text(client.name) || text(client.id) || null : null,
    method: text(s.method, 40),
    device: text(s.device) || "Unknown device",
    country: text(s.country, 8),
    createdAt: text(s.createdAt, 40),
    lastSeenAt: text(s.lastSeenAt, 40),
    current: s.current === true,
  };
}

/** The person's live Cumulus://ID sessions, the current one first, then most recently active. */
export async function listCidSessions(call: CidCall): Promise<CidResult<CidSession[]>> {
  const result = await callCid(call, "/api/id/sessions", { method: "GET" });
  if (result.status !== "ok") return result;
  const raw = Array.isArray(result.value.sessions) ? result.value.sessions : [];
  const sessions = raw.map(asSession).filter((s): s is CidSession => s !== null);
  sessions.sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt.localeCompare(a.lastSeenAt));
  return { status: "ok", value: sessions };
}

/** End one session. */
export async function revokeCidSession(call: CidCall, id: string): Promise<CidResult<true>> {
  if (!SAFE_ID.test(id)) return { status: "error", message: "That session id is not valid." };
  const result = await callCid(call, `/api/id/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  return result.status === "ok" ? { status: "ok", value: true } : result;
}

/** End every session except the one this token belongs to. */
export async function revokeOtherCidSessions(call: CidCall): Promise<CidResult<number>> {
  const result = await callCid(call, "/api/id/sessions/revoke-others", { method: "POST" });
  if (result.status !== "ok") return result;
  const ended = Number(result.value.ended);
  return { status: "ok", value: Number.isFinite(ended) ? ended : 0 };
}

const PUBLIC_KEY_BLOCK = "-----BEGIN PGP PUBLIC KEY BLOCK-----";

/** Publish an armored public key whose user ID is the person's own address. */
export async function publishCidMailKey(call: CidCall, armored: string): Promise<CidResult<PublishedKey>> {
  const body = armored.trim();
  if (!body.startsWith(PUBLIC_KEY_BLOCK)) return { status: "error", message: "That is not an armored OpenPGP public key." };
  if (body.length > 65_536) return { status: "error", message: "That key is too large (64 KB at most)." };
  const result = await callCid(call, "/api/id/keys", { method: "POST", body: { armored: body } });
  if (result.status !== "ok") return result;
  const key = (result.value.key ?? {}) as Record<string, unknown>;
  if (typeof key.id !== "string" || !SAFE_ID.test(key.id)) {
    return { status: "error", message: "Cumulus://ID did not return the published key." };
  }
  return {
    status: "ok",
    value: { id: key.id, address: text(key.address), fingerprint: text(key.fingerprint, 80), createdAt: text(key.createdAt, 40) },
  };
}

/** Withdraw a published key. */
export async function withdrawCidMailKey(call: CidCall, id: string): Promise<CidResult<true>> {
  if (!SAFE_ID.test(id)) return { status: "error", message: "That key id is not valid." };
  const result = await callCid(call, `/api/id/keys/${encodeURIComponent(id)}`, { method: "DELETE" });
  return result.status === "ok" ? { status: "ok", value: true } : result;
}

/**
 * Published keys for one address, from the public directory. Never throws:
 * any failure is an empty list, so the caller falls back to what it already has.
 */
export async function lookupCidMailKeys(
  issuer: string,
  address: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DirectoryKey[]> {
  const wanted = address.trim().toLowerCase();
  if (!wanted.includes("@") || wanted.length > 120) return [];
  try {
    const res = await fetchImpl(`${issuer.replace(/\/+$/, "")}/api/id/keys?address=${encodeURIComponent(wanted)}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const out = (await res.json()) as { keys?: unknown };
    if (!Array.isArray(out.keys)) return [];
    return out.keys.flatMap((value): DirectoryKey[] => {
      if (!value || typeof value !== "object") return [];
      const k = value as Record<string, unknown>;
      const armored = typeof k.armored === "string" ? k.armored.trim() : "";
      // Only keys the directory filed under the address that was asked for.
      if (text(k.address).toLowerCase() !== wanted || !armored.startsWith(PUBLIC_KEY_BLOCK)) return [];
      return [{ address: wanted, fingerprint: text(k.fingerprint, 80), armored }];
    });
  } catch {
    return [];
  }
}

/**
 * The keys to encrypt to, per recipient: the Cumulus://ID directory first, then
 * the key saved on the contact. `null` when any recipient has neither, which
 * means the message goes out without OpenPGP (as before).
 */
export function recipientKeys(
  recipients: string[],
  directory: Record<string, string[]>,
  contactKey: (address: string) => string | undefined,
): string[] | null {
  if (!recipients.length) return null;
  const keys: string[] = [];
  for (const recipient of recipients) {
    const address = recipient.trim().toLowerCase();
    const saved = contactKey(address);
    const published = directory[address] ?? [];
    const found = published.length ? published : saved ? [saved] : [];
    if (!found.length) return null;
    keys.push(...found);
  }
  return keys;
}
