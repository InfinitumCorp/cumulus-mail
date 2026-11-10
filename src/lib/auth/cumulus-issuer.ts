import { createLocalJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/** Keycloak-style realm for Cumulus://ID. Override with CUMULUS_OIDC_ISSUER. */
export const DEFAULT_CUMULUS_ISSUER = "https://id.cumuluscloud.app/realms/cumulus";

export function cumulusIssuer(env: NodeJS.ProcessEnv = process.env): string {
  return (env.CUMULUS_OIDC_ISSUER?.trim() || DEFAULT_CUMULUS_ISSUER).replace(/\/+$/, "");
}

export function cumulusJwksUrl(issuer = cumulusIssuer()): string {
  return `${issuer}/protocol/openid-connect/certs`;
}

export type VerifiedMailToken = {
  tenantId: string;
  subject: string;
  issuer: string;
};

/**
 * Verify an access token and read the tenant from the verified `tenant_id`
 * claim. The caller cannot supply the tenant separately.
 */
export async function verifyCumulusToken(
  token: string,
  options: { issuer?: string; keys: JWTVerifyGetKey },
): Promise<VerifiedMailToken> {
  const issuer = (options.issuer ?? cumulusIssuer()).replace(/\/+$/, "");
  const { payload } = await jwtVerify(token, options.keys, { issuer });
  const tenantId = payload.tenant_id;
  if (typeof tenantId !== "string" || !tenantId) throw new Error("Verified token has no tenant_id");
  if (typeof payload.sub !== "string" || !payload.sub) throw new Error("Verified token has no subject");
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
