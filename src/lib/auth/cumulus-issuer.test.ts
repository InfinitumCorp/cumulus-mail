import assert from "node:assert/strict";
import { test } from "node:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import {
  DEFAULT_CUMULUS_ISSUER,
  createLocalJWKSet,
  cumulusIssuer,
  cumulusJwksUrl,
  verifyCumulusToken,
} from "./cumulus-issuer.ts";

test("the default issuer is the Cumulus realm and the tenant comes only from the verified token", async () => {
  const previous = process.env.CUMULUS_OIDC_ISSUER;
  const previousJwks = process.env.CUMULUS_OIDC_JWKS_URL;
  delete process.env.CUMULUS_OIDC_ISSUER;
  delete process.env.CUMULUS_OIDC_JWKS_URL;
  try {
    assert.equal(cumulusIssuer(), DEFAULT_CUMULUS_ISSUER);
    assert.equal(
      DEFAULT_CUMULUS_ISSUER,
      "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_fRlMO7dna",
    );
    assert.equal(
      cumulusJwksUrl(),
      "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_fRlMO7dna/.well-known/jwks.json",
    );
    assert.equal(
      cumulusJwksUrl("https://id.cumuluscloud.app/realms/cumulus"),
      "https://id.cumuluscloud.app/realms/cumulus/protocol/openid-connect/certs",
    );
    process.env.CUMULUS_OIDC_JWKS_URL = "https://example.test/jwks";
    assert.equal(cumulusJwksUrl(), "https://example.test/jwks");
  } finally {
    if (previous === undefined) delete process.env.CUMULUS_OIDC_ISSUER;
    else process.env.CUMULUS_OIDC_ISSUER = previous;
    if (previousJwks === undefined) delete process.env.CUMULUS_OIDC_JWKS_URL;
    else process.env.CUMULUS_OIDC_JWKS_URL = previousJwks;
  }

  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "mail-test";
  const keys = createLocalJWKSet({ keys: [jwk] });
  const issuer = DEFAULT_CUMULUS_ISSUER;
  const token = await new SignJWT({ tenant_id: "tenant-a", email: "ada@cumuluscloud.app" })
    .setProtectedHeader({ alg: "RS256", kid: "mail-test" })
    .setIssuer(issuer)
    .setSubject("user-ada")
    .setExpirationTime("2h")
    .sign(privateKey);
  const verified = await verifyCumulusToken(token, { issuer, keys });
  assert.equal(verified.tenantId, "tenant-a");
  assert.equal(verified.subject, "user-ada");

  const wrongIssuer = await new SignJWT({ tenant_id: "tenant-a" })
    .setProtectedHeader({ alg: "RS256", kid: "mail-test" })
    .setIssuer("https://evil.example/realms/cumulus")
    .setSubject("user-ada")
    .setExpirationTime("2h")
    .sign(privateKey);
  await assert.rejects(() => verifyCumulusToken(wrongIssuer, { issuer, keys }));

  const noTenant = await new SignJWT({ preferred_tenant: "tenant-b" })
    .setProtectedHeader({ alg: "RS256", kid: "mail-test" })
    .setIssuer(issuer)
    .setSubject("user-ada")
    .setExpirationTime("2h")
    .sign(privateKey);
  await assert.rejects(() => verifyCumulusToken(noTenant, { issuer, keys }), /tenant_id/);

  const tampered = `${token.slice(0, -4)}aaaa`;
  await assert.rejects(() => verifyCumulusToken(tampered, { issuer, keys }));
});
