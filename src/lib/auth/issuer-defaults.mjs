/** Live Cumulus://ID realm. Override the app with CUMULUS_OIDC_ISSUER. */
export const DEFAULT_CUMULUS_ISSUER = "https://id.cumuluscloud.app/realms/cumulus";

/**
 * `jwks_uri` from the live discovery document at
 * `https://id.cumuluscloud.app/realms/cumulus/.well-known/openid-configuration`.
 * The document advertises ES256.
 */
export const DEFAULT_CUMULUS_JWKS_URI =
  "https://id.cumuluscloud.app/realms/cumulus/protocol/openid-connect/certs";

/** Previous Cumulus://ID issuer. Use only by setting CUMULUS_OIDC_ISSUER. */
export const COGNITO_CUMULUS_ISSUER =
  "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_fRlMO7dna";

/**
 * JWKS for an issuer. The live realm uses the discovery `jwks_uri`.
 * Cognito publishes `/.well-known/jwks.json`. Any other issuer keeps the
 * Keycloak realm path. CUMULUS_OIDC_JWKS_URL replaces this entirely.
 * @param {string} issuer
 */
export function jwksUrlForIssuer(issuer) {
  const trimmed = String(issuer || "").replace(/\/+$/, "");
  if (trimmed === DEFAULT_CUMULUS_ISSUER) return DEFAULT_CUMULUS_JWKS_URI;
  let host = "";
  try {
    host = new URL(trimmed).hostname;
  } catch {
    host = "";
  }
  if (/^cognito-idp\.[a-z0-9-]+\.amazonaws\.com$/i.test(host)) {
    return `${trimmed}/.well-known/jwks.json`;
  }
  return `${trimmed}/protocol/openid-connect/certs`;
}
