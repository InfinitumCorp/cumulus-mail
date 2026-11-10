import { createLocalJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { applyWorkerBindings } from "../cloudflare-env.ts";
import { DEFAULT_CUMULUS_ISSUER, jwksUrlForIssuer } from "./issuer-defaults.mjs";

export { DEFAULT_CUMULUS_ISSUER };

/** Cumulus://ID issuer. Override with CUMULUS_OIDC_ISSUER. Defaults to Cognito. */
export function cumulusIssuer(env: NodeJS.ProcessEnv = process.env): string {
  applyWorkerBindings();
  return (env.CUMULUS_OIDC_ISSUER?.trim() || DEFAULT_CUMULUS_ISSUER).replace(/\/+$/, "");
}

/** JWKS for the configured issuer. Override with CUMULUS_OIDC_JWKS_URL. */
export function cumulusJwksUrl(
  issuer = cumulusIssuer(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  applyWorkerBindings();
  const override = env.CUMULUS_OIDC_JWKS_URL?.trim();
  if (override) return override.replace(/\/+$/, "");
  return jwksUrlForIssuer(issuer);
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
  if (typeof payload.sub !== "string" || !payload.sub)
    throw new Error("Verified token has no subject");
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
