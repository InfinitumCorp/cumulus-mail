import assert from "node:assert/strict";
import { test } from "node:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import {
  DEFAULT_CUMULUS_COGNITO_DOMAIN,
  DEFAULT_CUMULUS_COGNITO_USER_POOL_ID,
  DEFAULT_CUMULUS_ISSUER,
  RETIRED_KEYCLOAK_ISSUER,
  cognitoPoolFromIssuer,
  createLocalJWKSet,
  cumulusDiscoveryUrl,
  cumulusIssuer,
  cumulusJwksUrl,
  fetchCumulusJwks,
  verifyCumulusToken,
} from "./cumulus-issuer.ts";

function withoutIssuerEnv<T>(run: () => T): T {
  const keep = {
    CUMULUS_OIDC_ISSUER: process.env.CUMULUS_OIDC_ISSUER,
    CUMULUS_OIDC_JWKS_URL: process.env.CUMULUS_OIDC_JWKS_URL,
    CUMULUS_COGNITO_REGION: process.env.CUMULUS_COGNITO_REGION,
    CUMULUS_COGNITO_USER_POOL_ID: process.env.CUMULUS_COGNITO_USER_POOL_ID,
  };
  for (const name of Object.keys(keep)) delete process.env[name];
  try {
    return run();
  } finally {
    for (const [name, value] of Object.entries(keep)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("the default issuer is the Cumulus://ID Cognito user pool, not the retired realm", () => {
  withoutIssuerEnv(() => {
    assert.equal(cumulusIssuer(), DEFAULT_CUMULUS_ISSUER);
    assert.equal(DEFAULT_CUMULUS_ISSUER, "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_fRlMO7dna");
    assert.notEqual(DEFAULT_CUMULUS_ISSUER, RETIRED_KEYCLOAK_ISSUER);
    // The hosted UI domain serves the browser endpoints and no discovery document.
    assert.equal(DEFAULT_CUMULUS_COGNITO_DOMAIN, "cumulus-id.auth.us-east-1.amazoncognito.com");
    assert.equal(cumulusIssuer().includes(DEFAULT_CUMULUS_COGNITO_DOMAIN), false);
  });
});

test("the pool, the region and the issuer come from the environment", () => {
  assert.equal(
    cumulusIssuer({ CUMULUS_COGNITO_USER_POOL_ID: "eu-west-1_Abc123" }),
    "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_Abc123",
  );
  assert.equal(
    cumulusIssuer({ CUMULUS_COGNITO_USER_POOL_ID: "eu-west-1_Abc123", CUMULUS_COGNITO_REGION: "eu-west-1" }),
    "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_Abc123",
  );
  // An explicit issuer always wins, so any other OIDC provider still works.
  assert.equal(
    cumulusIssuer({ CUMULUS_OIDC_ISSUER: " https://id.example/realms/cumulus/ ", CUMULUS_COGNITO_USER_POOL_ID: "x" }),
    "https://id.example/realms/cumulus",
  );
});

test("discovery and JWKS hang off the issuer, with the Keycloak path kept for a realm", () => {
  assert.equal(
    cumulusDiscoveryUrl(DEFAULT_CUMULUS_ISSUER),
    `${DEFAULT_CUMULUS_ISSUER}/.well-known/openid-configuration`,
  );
  assert.equal(cumulusJwksUrl(DEFAULT_CUMULUS_ISSUER, {}), `${DEFAULT_CUMULUS_ISSUER}/.well-known/jwks.json`);
  assert.equal(
    cumulusJwksUrl(RETIRED_KEYCLOAK_ISSUER, {}),
    `${RETIRED_KEYCLOAK_ISSUER}/protocol/openid-connect/certs`,
  );
  assert.equal(cumulusJwksUrl(DEFAULT_CUMULUS_ISSUER, { CUMULUS_OIDC_JWKS_URL: "https://keys.example/jwks" }), "https://keys.example/jwks");

  assert.deepEqual(cognitoPoolFromIssuer(DEFAULT_CUMULUS_ISSUER), {
    region: "us-east-1",
    userPoolId: DEFAULT_CUMULUS_COGNITO_USER_POOL_ID,
  });
  assert.equal(cognitoPoolFromIssuer(RETIRED_KEYCLOAK_ISSUER), null);
  // A pool id has to start with the region in the host, or it is not that pool.
  assert.equal(cognitoPoolFromIssuer("https://cognito-idp.us-east-1.amazonaws.com/eu-west-1_Abc123"), null);
});

test("JWKS comes from discovery, and a document for another issuer is refused", async () => {
  const calls: string[] = [];
  const respond = (body: unknown, ok = true) =>
    ({ ok, status: ok ? 200 : 500, json: async () => body }) as unknown as Response;

  const keys = await fetchCumulusJwks(DEFAULT_CUMULUS_ISSUER, {
    env: {},
    fetch: (async (input: string) => {
      calls.push(String(input));
      if (String(input).endsWith("/.well-known/openid-configuration")) {
        return respond({ issuer: DEFAULT_CUMULUS_ISSUER, jwks_uri: "https://keys.example/pool/jwks.json" });
      }
      return respond({ keys: [{ kid: "from-discovery" }] });
    }) as unknown as typeof fetch,
  });
  assert.deepEqual(calls, [
    `${DEFAULT_CUMULUS_ISSUER}/.well-known/openid-configuration`,
    "https://keys.example/pool/jwks.json",
  ]);
  assert.deepEqual(keys, { keys: [{ kid: "from-discovery" }] });

  await assert.rejects(
    () =>
      fetchCumulusJwks(DEFAULT_CUMULUS_ISSUER, {
        env: {},
        fetch: (async () => respond({ issuer: "https://evil.example", jwks_uri: "https://evil.example/jwks" })) as unknown as typeof fetch,
      }),
    /another issuer/,
  );

  // Discovery unreachable: fall back to the conventional path for the issuer.
  const fallback: string[] = [];
  await fetchCumulusJwks(DEFAULT_CUMULUS_ISSUER, {
    env: {},
    fetch: (async (input: string) => {
      fallback.push(String(input));
      if (String(input).endsWith("/.well-known/openid-configuration")) throw new Error("offline");
      return respond({ keys: [] });
    }) as unknown as typeof fetch,
  });
  assert.equal(fallback[1], `${DEFAULT_CUMULUS_ISSUER}/.well-known/jwks.json`);
});

test("the tenant comes only from the verified token", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "mail-test";
  const keys = createLocalJWKSet({ keys: [jwk] });
  const issuer = RETIRED_KEYCLOAK_ISSUER;
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

test("a Cognito token without tenant_id is scoped to its verified subject", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "cognito-test";
  const keys = createLocalJWKSet({ keys: [jwk] });
  const issuer = DEFAULT_CUMULUS_ISSUER;
  const sign = (claims: Record<string, unknown>) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "cognito-test" })
      .setIssuer(issuer)
      .setSubject("11111111-2222-3333-4444-555555555555")
      .setExpirationTime("2h")
      .sign(privateKey);

  const plain = await verifyCumulusToken(await sign({ "cognito:username": "ada" }), { issuer, keys });
  assert.equal(plain.tenantId, "11111111-2222-3333-4444-555555555555");
  assert.equal(plain.tenantId, plain.subject);

  // A pre-token-generation trigger that adds the claim still decides the tenant.
  const mapped = await verifyCumulusToken(await sign({ "custom:tenant_id": "tenant-ada" }), { issuer, keys });
  assert.equal(mapped.tenantId, "tenant-ada");
});
