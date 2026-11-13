import { createLocalJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { applyWorkerBindings } from "../cloudflare-env.ts";

/**
 * Cumulus://ID is its own OpenID Connect issuer, at the realm path on
 * `id.cumuluscloud.app`. Discovery and the JWKS hang off that issuer:
 *
 *   discovery  <issuer>/.well-known/openid-configuration
 *   jwks       <issuer>/protocol/openid-connect/certs   (ES256)
 *
 * Access tokens are RFC 9068 (`typ: at+jwt`): `sub` is the cid, `aud` is the
 * client id, and there is no `tenant_id` claim, so the verified `sub` is the
 * tenant.
 *
 * An Amazon Cognito user pool can still be named as an override
 * (`CUMULUS_COGNITO_USER_POOL_ID`); it is never the default. Nothing in this
 * file holds a client secret: Mail only verifies tokens here.
 */
export const DEFAULT_CUMULUS_ISSUER = "https://id.cumuluscloud.app/realms/cumulus";

/** `https://cognito-idp.<region>.amazonaws.com/<userPoolId>`, for the opt-in Cognito override. */
export function cognitoIssuer(region: string, userPoolId: string): string {
  return `https://cognito-idp.${region.trim().toLowerCase()}.amazonaws.com/${userPoolId.trim()}`;
}

const COGNITO_ISSUER = /^https:\/\/cognito-idp\.([a-z0-9-]+)\.amazonaws\.com\/([a-z0-9-]+_[A-Za-z0-9]+)$/;

/** A user-pool issuer, and the region plus pool id in it. */
export function cognitoPoolFromIssuer(issuer: string): { region: string; userPoolId: string } | null {
  const match = COGNITO_ISSUER.exec(issuer.replace(/\/+$/, ""));
  if (!match) return null;
  const [, region, userPoolId] = match;
  // A pool id always starts with its own region, so a mismatched pair is not a pool.
  return userPoolId.startsWith(`${region}_`) ? { region, userPoolId } : null;
}

type IssuerEnv = {
  CUMULUS_OIDC_ISSUER?: string;
  CUMULUS_OIDC_JWKS_URL?: string;
  CUMULUS_COGNITO_REGION?: string;
  CUMULUS_COGNITO_USER_POOL_ID?: string;
};

/**
 * The issuer Mail verifies bearer tokens against:
 *   1. `CUMULUS_OIDC_ISSUER`, used verbatim (any OIDC issuer).
 *   2. `CUMULUS_COGNITO_USER_POOL_ID` (+ optional `CUMULUS_COGNITO_REGION`,
 *      which defaults to the region the pool id starts with): opt-in only.
 *   3. Cumulus://ID's own issuer, `DEFAULT_CUMULUS_ISSUER`.
 */
export function cumulusIssuer(env: IssuerEnv = process.env): string {
  applyWorkerBindings();
  const configured = env.CUMULUS_OIDC_ISSUER?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const userPoolId = env.CUMULUS_COGNITO_USER_POOL_ID?.trim();
  if (userPoolId) {
    const region = env.CUMULUS_COGNITO_REGION?.trim() || userPoolId.split("_")[0];
    return cognitoIssuer(region, userPoolId);
  }
  return DEFAULT_CUMULUS_ISSUER;
}

/** OpenID discovery for an issuer. Cumulus://ID and Cognito both answer here. */
export function cumulusDiscoveryUrl(issuer = cumulusIssuer()): string {
  return `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
}

/**
 * Where the signing keys are, without a network round trip:
 * `CUMULUS_OIDC_JWKS_URL` when set, the `/protocol/openid-connect/certs` path
 * for a `/realms/<name>` issuer (Cumulus://ID), and otherwise the standard
 * `/.well-known/jwks.json` that Cognito publishes. `fetchCumulusJwks` prefers discovery and falls back to this.
 */
export function cumulusJwksUrl(issuer = cumulusIssuer(), env: IssuerEnv = process.env): string {
  applyWorkerBindings();
  const configured = env.CUMULUS_OIDC_JWKS_URL?.trim();
  if (configured) return configured;
  const base = issuer.replace(/\/+$/, "");
  if (/\/realms\/[^/]+$/.test(base)) return `${base}/protocol/openid-connect/certs`;
  return `${base}/.well-known/jwks.json`;
}

export type JwkSet = { keys: unknown[] };

/**
 * Read the signing keys for `issuer`: OpenID discovery first, so a provider that
 * publishes its JWKS somewhere else still works, then the conventional path.
 * A discovery document whose `issuer` is not the expected one is refused, so a
 * redirected or swapped document cannot hand over keys for another realm.
 */
export async function fetchCumulusJwks(
  issuer = cumulusIssuer(),
  options: { fetch?: typeof fetch; env?: IssuerEnv } = {},
): Promise<JwkSet> {
  const get = options.fetch ?? fetch;
  const env = options.env ?? process.env;
  const expected = issuer.replace(/\/+$/, "");
  let jwksUrl = cumulusJwksUrl(expected, env);
  if (!env.CUMULUS_OIDC_JWKS_URL?.trim()) {
    try {
      const discovery = await get(cumulusDiscoveryUrl(expected));
      if (discovery.ok) {
        const document = (await discovery.json()) as { issuer?: unknown; jwks_uri?: unknown };
        if (document.issuer !== expected) throw new Error("OIDC discovery returned another issuer");
        if (typeof document.jwks_uri !== "string" || !document.jwks_uri.startsWith("https://")) {
          throw new Error("OIDC discovery has no https jwks_uri");
        }
        jwksUrl = document.jwks_uri;
      }
    } catch (error) {
      // A reachable issuer with an unusable document is a misconfiguration, not
      // a reason to guess. Only a transport failure falls back to the path.
      if (error instanceof Error && error.message.startsWith("OIDC discovery")) throw error;
    }
  }
  const response = await get(jwksUrl);
  if (!response.ok) throw new Error(`JWKS returned HTTP ${response.status}`);
  return (await response.json()) as JwkSet;
}

export type VerifiedMailToken = {
  tenantId: string;
  subject: string;
  issuer: string;
};

/**
 * Verify an access token and read the tenant from a verified claim. The caller
 * cannot supply the tenant separately.
 *
 *   - A `tenant_id` (or `custom:tenant_id`) claim decides the tenant when present.
 *   - A Cumulus://ID access token (`typ: at+jwt`) has none: the verified `sub`
 *     (the cid) is the tenant. When `audience` is given, the token's `aud` must
 *     include it, so a token minted for another product is refused.
 *   - A Cognito user-pool token has none either: its verified `sub` is the tenant.
 *
 * Anything else without a tenant claim (an ID token, say) is refused. Every
 * value comes out of the signature-checked token; none is read from the request.
 */
export async function verifyCumulusToken(
  token: string,
  options: { issuer?: string; keys: JWTVerifyGetKey; audience?: string },
): Promise<VerifiedMailToken> {
  const issuer = (options.issuer ?? cumulusIssuer()).replace(/\/+$/, "");
  const { payload, protectedHeader } = await jwtVerify(token, options.keys, { issuer });
  if (typeof payload.sub !== "string" || !payload.sub) throw new Error("Verified token has no subject");
  const accessToken = String(protectedHeader.typ ?? "").toLowerCase().replace(/^application\//, "") === "at+jwt";
  if (accessToken && options.audience) {
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(options.audience)) throw new Error("Verified token is for another client");
  }
  const claimed = payload.tenant_id ?? payload["custom:tenant_id"];
  const tenantId =
    typeof claimed === "string" && claimed
      ? claimed
      : accessToken || cognitoPoolFromIssuer(issuer)
        ? payload.sub
        : "";
  if (!tenantId) throw new Error("Verified token has no tenant_id");
  return { tenantId, subject: payload.sub, issuer };
}

export function unverifiedIssuer(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as { iss?: unknown };
    return typeof payload.iss === "string" ? payload.iss : null;
  } catch {
    return null;
  }
}

export { createLocalJWKSet };
