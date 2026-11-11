import { createLocalJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { applyWorkerBindings } from "../cloudflare-env.ts";

/**
 * Cumulus://ID signs in through an Amazon Cognito user pool. The issuer of a
 * Cognito pool is `https://cognito-idp.<region>.amazonaws.com/<userPoolId>`,
 * and both discovery and JWKS hang off that host — not off the hosted-UI domain
 * (`<prefix>.auth.<region>.amazoncognito.com`), which only serves the browser
 * endpoints (`/oauth2/authorize`, `/oauth2/token`, `/logout`).
 *
 * The pool and the region are account configuration, not secrets, so they are
 * defaults here and overridable by environment. Nothing in this file holds a
 * client secret; Mail only verifies tokens, it never exchanges a code.
 */
export const DEFAULT_CUMULUS_COGNITO_REGION = "us-east-1";
export const DEFAULT_CUMULUS_COGNITO_USER_POOL_ID = "us-east-1_fRlMO7dna";
/** Hosted UI origin for the pool. Mail does not call it; it is here for links and docs. */
export const DEFAULT_CUMULUS_COGNITO_DOMAIN = "cumulus-id.auth.us-east-1.amazoncognito.com";

/** `https://cognito-idp.<region>.amazonaws.com/<userPoolId>`. */
export function cognitoIssuer(region: string, userPoolId: string): string {
  return `https://cognito-idp.${region.trim().toLowerCase()}.amazonaws.com/${userPoolId.trim()}`;
}

/** The Cognito user pool Cumulus://ID uses, unless the environment names another. */
export const DEFAULT_CUMULUS_ISSUER = cognitoIssuer(
  DEFAULT_CUMULUS_COGNITO_REGION,
  DEFAULT_CUMULUS_COGNITO_USER_POOL_ID,
);

/** The Keycloak realm Cumulus://ID used before Cognito. `id.cumuluscloud.app` answers 404. */
export const RETIRED_KEYCLOAK_ISSUER = "https://id.cumuluscloud.app/realms/cumulus";

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
 *   1. `CUMULUS_OIDC_ISSUER`, used verbatim (any OIDC issuer, Keycloak included).
 *   2. `CUMULUS_COGNITO_USER_POOL_ID` (+ optional `CUMULUS_COGNITO_REGION`,
 *      which defaults to the region the pool id starts with).
 *   3. The Cognito pool above.
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

/** OpenID discovery for an issuer. Cognito and Keycloak both answer here. */
export function cumulusDiscoveryUrl(issuer = cumulusIssuer()): string {
  return `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
}

/**
 * Where the signing keys are, without a network round trip:
 * `CUMULUS_OIDC_JWKS_URL` when set, the Keycloak path for a `/realms/<name>`
 * issuer, and otherwise the standard `/.well-known/jwks.json` that Cognito
 * publishes. `fetchCumulusJwks` prefers discovery and falls back to this.
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
 * `tenant_id` is the claim Cumulus://ID mints. A Cognito user pool has no such
 * claim unless a pre-token-generation trigger adds one, so for a user-pool
 * issuer the verified `sub` is the tenant. Both come out of the signature-checked
 * payload; neither is read from the request.
 */
export async function verifyCumulusToken(
  token: string,
  options: { issuer?: string; keys: JWTVerifyGetKey },
): Promise<VerifiedMailToken> {
  const issuer = (options.issuer ?? cumulusIssuer()).replace(/\/+$/, "");
  const { payload } = await jwtVerify(token, options.keys, { issuer });
  if (typeof payload.sub !== "string" || !payload.sub) throw new Error("Verified token has no subject");
  const claimed = payload.tenant_id ?? payload["custom:tenant_id"];
  const tenantId =
    typeof claimed === "string" && claimed ? claimed : cognitoPoolFromIssuer(issuer) ? payload.sub : "";
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
