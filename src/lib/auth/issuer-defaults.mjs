/**
 * Cumulus://ID signs in through an Amazon Cognito user pool. This plain-JS copy
 * of the default is for scripts (smoke, live checks); the app reads
 * src/lib/auth/cumulus-issuer.ts. Override with CUMULUS_OIDC_ISSUER.
 */
export const DEFAULT_CUMULUS_ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_fRlMO7dna";

/** Cognito publishes the user pool's signing keys here. */
export const DEFAULT_CUMULUS_JWKS_URI = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_fRlMO7dna/.well-known/jwks.json";

/** The Keycloak realm Cumulus://ID used before Cognito. It no longer answers. */
export const RETIRED_KEYCLOAK_ISSUER = "https://id.cumuluscloud.app/realms/cumulus";

/**
 * JWKS for an issuer: a Keycloak `/realms/<name>` issuer uses the realm certs
 * path, anything else (Cognito included) uses `/.well-known/jwks.json`.
 * CUMULUS_OIDC_JWKS_URL replaces this entirely.
 * @param {string} issuer
 */
export function jwksUrlForIssuer(issuer) {
  const trimmed = String(issuer || "").replace(/\/+$/, "");
  if (/\/realms\/[^/]+$/.test(trimmed)) return `${trimmed}/protocol/openid-connect/certs`;
  return `${trimmed}/.well-known/jwks.json`;
}
