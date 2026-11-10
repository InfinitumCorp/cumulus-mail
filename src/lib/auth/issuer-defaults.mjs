/** Live Cumulus://ID. Override the app with CUMULUS_OIDC_ISSUER. */
export const DEFAULT_CUMULUS_ISSUER =
  "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_fRlMO7dna";

/**
 * JWKS for an issuer. Cognito publishes `/.well-known/jwks.json`.
 * Any other issuer keeps the Keycloak realm path so a future realm still verifies.
 * @param {string} issuer
 */
export function jwksUrlForIssuer(issuer) {
  const trimmed = String(issuer || "").replace(/\/+$/, "");
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
