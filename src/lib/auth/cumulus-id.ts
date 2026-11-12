/**
 * "Sign in with Cumulus ID" for Cumulus://Mail.
 *
 * Cumulus ID (https://id.cumuluscloud.app) is the only way people sign in.
 * Mail's own Better Auth runs a generic OAuth provider against it:
 *
 *   1. GET  <issuer>/api/id/authorize?client_id&redirect_uri&code_challenge(S256)&state
 *      Signed out at Cumulus ID: its sign-in page opens, with "Create a Cumulus ID"
 *      on the same page, and the authorize continues once the person is signed in.
 *   2. Back at /api/auth/callback/<providerId>?code&state.
 *   3. POST <issuer>/api/id/token { code, code_verifier, client_id, redirect_uri }
 *      -> { access_token, expires_in, profile: { cid, username, email, name, handle } }.
 *
 * Dependency-free so the client can import the provider list. The issuer is
 * configurable (`CID_ISSUER`) so a mirror that loads in Russia without a VPN can
 * be dropped in. No client secret: the flow is a public client with PKCE.
 */

export const DEFAULT_CID_ISSUER = "https://id.cumuluscloud.app";
/** The client id nexus registers for mail.cumuluscloud.app and ru.mail.cumuluscloud.app. */
export const DEFAULT_CID_CLIENT_ID = "cumulus-mail";
/** Cumulus ID mirror for the Russia copy (ru.* hosts): loads in Russia without a VPN. */
export const DEFAULT_CID_ISSUER_RU = "https://ru.id.cumuluscloud.app";

export const CUMULUS_ID_PROVIDER_ID = "cumulus-id";
/** Same client and issuer; asks Cumulus ID to open on "Create a Cumulus ID". */
export const CUMULUS_ID_CREATE_PROVIDER_ID = "cumulus-id-create";

export type SignInProvider = {
  /** Better Auth provider id; also the callback path segment. */
  providerId: string;
  /** Button text. */
  label: string;
  /** Send `prompt=create` so Cumulus ID opens on account creation. */
  create: boolean;
};

export const SIGN_IN_PROVIDERS: readonly SignInProvider[] = [
  { providerId: CUMULUS_ID_PROVIDER_ID, label: "Sign in with Cumulus ID", create: false },
  { providerId: CUMULUS_ID_CREATE_PROVIDER_ID, label: "Create a Cumulus ID", create: true },
];

type CidEnv = { CID_ISSUER?: string; CID_ISSUER_RU?: string; CID_CLIENT_ID?: string };

export type CidConfig = { issuer: string; clientId: string };

export function cidConfig(env: CidEnv = process.env): CidConfig {
  const issuer = (env.CID_ISSUER?.trim() || DEFAULT_CID_ISSUER).replace(/\/+$/, "");
  const clientId = env.CID_CLIENT_ID?.trim() || DEFAULT_CID_CLIENT_ID;
  return { issuer, clientId };
}

/**
 * Cumulus ID for a region: the Russia copy (ru.* hosts, or MAIL_REGION=ru) signs in through the mirror,
 * `CID_ISSUER_RU` or https://ru.id.cumuluscloud.app; everyone else through `CID_ISSUER` or
 * https://id.cumuluscloud.app. The client id is the same for both.
 */
export function cidConfigForRegion(region: "us" | "ru", env: CidEnv = process.env): CidConfig {
  const base = cidConfig(env);
  if (region !== "ru") return base;
  const issuer = (env.CID_ISSUER_RU?.trim() || DEFAULT_CID_ISSUER_RU).replace(/\/+$/, "");
  return { issuer, clientId: base.clientId };
}

export const cidAuthorizeUrl = (issuer: string) => `${issuer}/api/id/authorize`;
export const cidTokenUrl = (issuer: string) => `${issuer}/api/id/token`;
export const cidUserInfoUrl = (issuer: string) => `${issuer}/api/id/userinfo`;

export type CidProfile = {
  cid: string;
  username?: string;
  email?: string;
  name?: string;
  handle?: string;
};

/** Token set in Better Auth's OAuth2Tokens shape. */
export type CidTokens = {
  tokenType: string;
  accessToken: string;
  accessTokenExpiresAt?: Date;
  idToken?: string;
  raw: Record<string, unknown>;
};

function asProfile(value: unknown): CidProfile | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  if (typeof p.cid !== "string" || !p.cid) return null;
  const s = (k: string) => (typeof p[k] === "string" && p[k] ? (p[k] as string) : undefined);
  return { cid: p.cid, username: s("username"), email: s("email"), name: s("name"), handle: s("handle") };
}

/** Redeem the code at Cumulus ID. Throws a plain-language error on failure. */
export async function exchangeCidCode(
  config: CidConfig,
  data: { code: string; redirectURI: string; codeVerifier?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<CidTokens> {
  if (!data.codeVerifier) throw new Error("Cumulus ID sign-in is missing its PKCE verifier.");
  let res: Response;
  try {
    res = await fetchImpl(cidTokenUrl(config.issuer), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        code: data.code,
        code_verifier: data.codeVerifier,
        client_id: config.clientId,
        redirect_uri: data.redirectURI,
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error("Cumulus ID could not be reached. Please try again.");
  }
  const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const accessToken = typeof out.access_token === "string" ? out.access_token : "";
  if (!res.ok || !accessToken) {
    throw new Error(typeof out.error === "string" ? out.error : "Cumulus ID did not accept that sign-in.");
  }
  const expiresIn = Number(out.expires_in);
  return {
    tokenType: typeof out.token_type === "string" ? out.token_type : "Bearer",
    accessToken,
    accessTokenExpiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : undefined,
    idToken: typeof out.id_token === "string" ? out.id_token : undefined,
    raw: out,
  };
}

/**
 * The person behind a token set: the profile the token endpoint returned, or
 * `/api/id/userinfo` when it returned none.
 */
export async function cidProfileFromTokens(
  config: CidConfig,
  tokens: { accessToken?: string; raw?: Record<string, unknown> },
  fetchImpl: typeof fetch = fetch,
): Promise<CidProfile | null> {
  const inline = asProfile(tokens.raw?.profile);
  if (inline) return inline;
  if (!tokens.accessToken) return null;
  try {
    const res = await fetchImpl(cidUserInfoUrl(config.issuer), {
      headers: { authorization: `Bearer ${tokens.accessToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    return asProfile(await res.json());
  } catch {
    return null;
  }
}

/** Better Auth user info for a Cumulus ID profile. The CID is the stable account id. */
export function cidUserInfo(profile: CidProfile) {
  const email = (profile.email ?? "").trim().toLowerCase();
  return {
    id: profile.cid,
    sub: profile.cid,
    // Every CID owns a mailbox; the IdP reports it, or a linked address it verified.
    email: email || `${profile.cid}@cumulus-id.invalid`,
    emailVerified: Boolean(email),
    name: profile.name || profile.username || profile.handle || "Cumulus",
  };
}
