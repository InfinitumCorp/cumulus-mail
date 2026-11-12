import { getRequest } from "@tanstack/react-start/server";
import { cidConfig } from "./cumulus-id.ts";
import { SIGN_IN_PROVIDERS } from "./providers";
import { auth, authConfigured } from "./server";

/**
 * The Cumulus://ID access token Better Auth stored (encrypted) on the signed-in
 * person's account row at sign-in. Server-only.
 *
 * Mail asks for `openid profile email` without `offline_access`, so there is no
 * refresh token: once the access token expires (an hour at most) this returns
 * it with its expiry, and `cid-account.ts` reports "signed-out" instead of
 * calling Cumulus://ID.
 */
const CID_PROVIDERS = new Set(SIGN_IN_PROVIDERS.map((p) => p.providerId));

export type StoredCidToken = { accessToken: string | null; accessTokenExpiresAt: Date | null };

const NONE: StoredCidToken = { accessToken: null, accessTokenExpiresAt: null };

function requestHeaders(bearerToken?: string): Headers | null {
  const request = getRequest();
  if (!request) return null;
  if (!bearerToken) return request.headers;
  const headers = new Headers(request.headers);
  headers.set("Authorization", `Bearer ${bearerToken}`);
  return headers;
}

export async function storedCidToken(bearerToken?: string): Promise<StoredCidToken> {
  if (!authConfigured) return NONE;
  const headers = requestHeaders(bearerToken);
  if (!headers) return NONE;
  let accounts: Array<{ id: string; providerId: string; updatedAt?: Date | string }>;
  try {
    accounts = (await auth.api.listUserAccounts({ headers })) as typeof accounts;
  } catch {
    return NONE;
  }
  const newest = accounts
    .filter((account) => CID_PROVIDERS.has(account.providerId))
    .sort((a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime());
  for (const account of newest) {
    try {
      const tokens = await auth.api.getAccessToken({ body: { accountId: account.id }, headers });
      if (tokens?.accessToken) {
        const expires = tokens.accessTokenExpiresAt ? new Date(tokens.accessTokenExpiresAt) : null;
        return { accessToken: tokens.accessToken, accessTokenExpiresAt: expires };
      }
    } catch {
      // Try the next linked Cumulus://ID account row.
    }
  }
  return NONE;
}

/** Issuer plus the stored token, in the shape `cid-account.ts` takes. */
export async function cidCall(bearerToken?: string) {
  const { issuer } = cidConfig();
  return { issuer, ...(await storedCidToken(bearerToken)) };
}
