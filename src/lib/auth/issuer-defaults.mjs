/**
 * Cumulus://ID is its own OpenID Connect issuer at the realm path. This
 * plain-JS copy of the default is for scripts (smoke, live checks); the app
 * reads src/lib/auth/cumulus-issuer.ts. Override with CUMULUS_OIDC_ISSUER.
 */
export const DEFAULT_CUMULUS_ISSUER = "https://id.cumuluscloud.app/realms/cumulus";

/** Cumulus://ID publishes its ES256 signing keys here (also `jwks_uri` in discovery). */
export const DEFAULT_CUMULUS_JWKS_URI = "https://id.cumuluscloud.app/realms/cumulus/protocol/openid-connect/certs";

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
