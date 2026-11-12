import { createLocalJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { applyWorkerBindings } from "../cloudflare-env.ts";

/**
 * Optional cross-app bearer tokens. People sign in to Mail with Google (see
 * `server.ts`); this file only matters when another first-party app hands Mail
 * an OIDC access token. That path is OFF unless `CUMULUS_OIDC_ISSUER` names the
 * issuer to trust, and the tenant then comes from the verified `tenant_id`
 * claim. There is no built-in default issuer.
 */
type IssuerEnv = {
  CUMULUS_OIDC_ISSUER?: string;
  CUMULUS_OIDC_JWKS_URL?: string;
};

/** The issuer Mail verifies cross-app bearer tokens against, or null when none is configured. */
export function cumulusIssuer(env: IssuerEnv = process.env): string | null {
  applyWorkerBindings();
  const configured = env.CUMULUS_OIDC_ISSUER?.trim();
  return configured ? configured.replace(/\/+$/, "") : null;
}

/** OpenID discovery for an issuer. */
export function cumulusDiscoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
}

/**
 * Where the signing keys are, without a network round trip:
 * `CUMULUS_OIDC_JWKS_URL` when set, the Keycloak path for a `/realms/<name>`
 * issuer, and otherwise the conventional `/.well-known/jwks.json`. `fetchCumulusJwks` prefers discovery and falls back to this.
 */
export function cumulusJwksUrl(issuer: string, env: IssuerEnv = process.env): string {
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
  issuer: string,
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
 * `tenant_id` comes out of the signature-checked payload; it is never read
 * from the request. A token without it is refused.
 */
export async function verifyCumulusToken(
  token: string,
  options: { issuer: string; keys: JWTVerifyGetKey },
): Promise<VerifiedMailToken> {
  const issuer = options.issuer.replace(/\/+$/, "");
  const { payload } = await jwtVerify(token, options.keys, { issuer });
  if (typeof payload.sub !== "string" || !payload.sub) throw new Error("Verified token has no subject");
  const claimed = payload.tenant_id;
  const tenantId = typeof claimed === "string" ? claimed : "";
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
