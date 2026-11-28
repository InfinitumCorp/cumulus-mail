/**
 * Cumulus://ID is the realm at https://id.cumuluscloud.app/realms/cumulus. This plain-JS copy of the
 * default is for scripts (smoke, live checks); the app reads src/lib/auth/cumulus-issuer.ts. Override
 * with CUMULUS_OIDC_ISSUER.
 */
export const DEFAULT_CUMULUS_ISSUER = "https://id.cumuluscloud.app/realms/cumulus";

/** The realm publishes its signing keys here. */
export const DEFAULT_CUMULUS_JWKS_URI = "https://id.cumuluscloud.app/realms/cumulus/protocol/openid-connect/certs";

/** The Cognito pool once planned for Cumulus://ID; its discovery answers 404. Kept for reference. */
export const LEGACY_COGNITO_ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_fRlMO7dna";

/**
 * JWKS for an issuer: a `/realms/<name>` issuer (Cumulus://ID) uses the realm
 * certs path, anything else (a Cognito pool included) uses
 * `/.well-known/jwks.json`. CUMULUS_OIDC_JWKS_URL replaces this entirely.
 * @param {string} issuer
 */
export function jwksUrlForIssuer(issuer) {
  const trimmed = String(issuer || "").replace(/\/+$/, "");
  if (/\/realms\/[^/]+$/.test(trimmed)) return `${trimmed}/protocol/openid-connect/certs`;
  return `${trimmed}/.well-known/jwks.json`;
}
