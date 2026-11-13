import assert from "node:assert/strict";
import { test } from "node:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import {
  DEFAULT_CUMULUS_ISSUER,
  cognitoIssuer,
  cognitoPoolFromIssuer,
  createLocalJWKSet,
  cumulusDiscoveryUrl,
  cumulusIssuer,
  cumulusJwksUrl,
  fetchCumulusJwks,
  verifyCumulusToken,
} from "./cumulus-issuer.ts";

const COGNITO_POOL_ISSUER = cognitoIssuer("us-east-1", "us-east-1_fRlMO7dna");

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

test("the default issuer is Cumulus://ID's own realm, not a Cognito pool", () => {
  withoutIssuerEnv(() => {
    assert.equal(cumulusIssuer(), DEFAULT_CUMULUS_ISSUER);
    assert.equal(DEFAULT_CUMULUS_ISSUER, "https://id.cumuluscloud.app/realms/cumulus");
    assert.equal(cognitoPoolFromIssuer(cumulusIssuer()), null);
  });
});

test("a Cognito pool is an opt-in override, and an explicit issuer always wins", () => {
  assert.equal(cumulusIssuer({}), DEFAULT_CUMULUS_ISSUER);
  assert.equal(
    cumulusIssuer({ CUMULUS_COGNITO_USER_POOL_ID: "eu-west-1_Abc123" }),
    "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_Abc123",
  );
  assert.equal(
    cumulusIssuer({ CUMULUS_COGNITO_USER_POOL_ID: "eu-west-1_Abc123", CUMULUS_COGNITO_REGION: "eu-west-1" }),
    "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_Abc123",
  );
  assert.equal(
    cumulusIssuer({ CUMULUS_OIDC_ISSUER: " https://id.example/realms/cumulus/ ", CUMULUS_COGNITO_USER_POOL_ID: "x" }),
    "https://id.example/realms/cumulus",
  );
});

test("discovery and JWKS hang off the issuer: realm certs for Cumulus://ID, jwks.json for Cognito", () => {
  assert.equal(
    cumulusDiscoveryUrl(DEFAULT_CUMULUS_ISSUER),
    "https://id.cumuluscloud.app/realms/cumulus/.well-known/openid-configuration",
  );
  assert.equal(
    cumulusJwksUrl(DEFAULT_CUMULUS_ISSUER, {}),
    "https://id.cumuluscloud.app/realms/cumulus/protocol/openid-connect/certs",
  );
  assert.equal(cumulusJwksUrl(COGNITO_POOL_ISSUER, {}), `${COGNITO_POOL_ISSUER}/.well-known/jwks.json`);
  assert.equal(cumulusJwksUrl(DEFAULT_CUMULUS_ISSUER, { CUMULUS_OIDC_JWKS_URL: "https://keys.example/jwks" }), "https://keys.example/jwks");

  assert.deepEqual(cognitoPoolFromIssuer(COGNITO_POOL_ISSUER), { region: "us-east-1", userPoolId: "us-east-1_fRlMO7dna" });
  assert.equal(cognitoPoolFromIssuer(DEFAULT_CUMULUS_ISSUER), null);
  // A pool id has to start with the region in the host, or it is not that pool.
  assert.equal(cognitoPoolFromIssuer("https://cognito-idp.us-east-1.amazonaws.com/eu-west-1_Abc123"), null);
});

test("JWKS comes from discovery, and a document for another issuer is refused", async () => {
  const calls: string[] = [];
  const respond = (body: unknown, ok = true) =>
    ({ ok, status: ok ? 200 : 500, json: async () => body }) as unknown as Response;
  const certs = `${DEFAULT_CUMULUS_ISSUER}/protocol/openid-connect/certs`;

  const keys = await fetchCumulusJwks(DEFAULT_CUMULUS_ISSUER, {
    env: {},
    fetch: (async (input: string) => {
      calls.push(String(input));
      if (String(input).endsWith("/.well-known/openid-configuration")) {
        return respond({ issuer: DEFAULT_CUMULUS_ISSUER, jwks_uri: certs });
      }
      return respond({ keys: [{ kid: "from-discovery", kty: "EC", crv: "P-256" }] });
    }) as unknown as typeof fetch,
  });
  assert.deepEqual(calls, [`${DEFAULT_CUMULUS_ISSUER}/.well-known/openid-configuration`, certs]);
  assert.deepEqual(keys, { keys: [{ kid: "from-discovery", kty: "EC", crv: "P-256" }] });

  await assert.rejects(
    () =>
      fetchCumulusJwks(DEFAULT_CUMULUS_ISSUER, {
        env: {},
        fetch: (async () => respond({ issuer: "https://evil.example", jwks_uri: "https://evil.example/jwks" })) as unknown as typeof fetch,
      }),
    /another issuer/,
  );

  // Discovery unreachable: fall back to the realm certs path.
  const fallback: string[] = [];
  await fetchCumulusJwks(DEFAULT_CUMULUS_ISSUER, {
    env: {},
    fetch: (async (input: string) => {
      fallback.push(String(input));
      if (String(input).endsWith("/.well-known/openid-configuration")) throw new Error("offline");
      return respond({ keys: [] });
    }) as unknown as typeof fetch,
  });
  assert.equal(fallback[1], certs);
});

test("a Cumulus://ID ES256 access token verifies, and its cid is the tenant", async () => {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "cid-test";
  const keys = createLocalJWKSet({ keys: [jwk] });
  const issuer = DEFAULT_CUMULUS_ISSUER;
  const cid = "cid_7c1e0a9b";
  const sign = (claims: Record<string, unknown>, typ = "at+jwt", iss = issuer, aud = "cumulus-mail") =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256", kid: "cid-test", typ })
      .setIssuer(iss)
      .setSubject(cid)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);

  const token = await sign({ client_id: "cumulus-mail", scope: "openid profile email", sid: "ses_1" });
  const verified = await verifyCumulusToken(token, { issuer, keys, audience: "cumulus-mail" });
  assert.equal(verified.tenantId, cid);
  assert.equal(verified.subject, cid);
  assert.equal(verified.issuer, issuer);

  // A token minted for another product is not Mail's.
  const other = await sign({ client_id: "cumulus-drive", sid: "ses_1" }, "at+jwt", issuer, "cumulus-drive");
  await assert.rejects(() => verifyCumulusToken(other, { issuer, keys, audience: "cumulus-mail" }), /another client/);

  // An ID token (typ JWT, no tenant claim) is not an access token.
  const idToken = await sign({ email: "ada@cumuluscloud.app", nonce: "n" }, "JWT");
  await assert.rejects(() => verifyCumulusToken(idToken, { issuer, keys, audience: "cumulus-mail" }), /tenant_id/);

  const wrongIssuer = await sign({ sid: "ses_1" }, "at+jwt", "https://evil.example/realms/cumulus");
  await assert.rejects(() => verifyCumulusToken(wrongIssuer, { issuer, keys, audience: "cumulus-mail" }));

  const tampered = `${token.slice(0, -4)}aaaa`;
  await assert.rejects(() => verifyCumulusToken(tampered, { issuer, keys, audience: "cumulus-mail" }));
});

test("a tenant_id claim still decides the tenant for another configured issuer", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "mail-test";
  const keys = createLocalJWKSet({ keys: [jwk] });
  const issuer = "https://id.example/realms/cumulus";
  const token = await new SignJWT({ tenant_id: "tenant-a", email: "ada@cumuluscloud.app" })
    .setProtectedHeader({ alg: "RS256", kid: "mail-test" })
    .setIssuer(issuer)
    .setSubject("user-ada")
    .setExpirationTime("2h")
    .sign(privateKey);
  const verified = await verifyCumulusToken(token, { issuer, keys });
  assert.equal(verified.tenantId, "tenant-a");
  assert.equal(verified.subject, "user-ada");

  const noTenant = await new SignJWT({ preferred_tenant: "tenant-b" })
    .setProtectedHeader({ alg: "RS256", kid: "mail-test" })
    .setIssuer(issuer)
    .setSubject("user-ada")
    .setExpirationTime("2h")
    .sign(privateKey);
  await assert.rejects(() => verifyCumulusToken(noTenant, { issuer, keys }), /tenant_id/);
});

test("an opt-in Cognito token without tenant_id is scoped to its verified subject", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "cognito-test";
  const keys = createLocalJWKSet({ keys: [jwk] });
  const issuer = COGNITO_POOL_ISSUER;
  const sign = (claims: Record<string, unknown>) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "cognito-test" })
      .setIssuer(issuer)
      .setSubject("11111111-2222-3333-4444-555555555555")
      .setExpirationTime("2h")
      .sign(privateKey);

  const plain = await verifyCumulusToken(await sign({ "cognito:username": "ada" }), { issuer, keys, audience: "cumulus-mail" });
  assert.equal(plain.tenantId, "11111111-2222-3333-4444-555555555555");
  assert.equal(plain.tenantId, plain.subject);

  // A pre-token-generation trigger that adds the claim still decides the tenant.
  const mapped = await verifyCumulusToken(await sign({ "custom:tenant_id": "tenant-ada" }), { issuer, keys });
  assert.equal(mapped.tenantId, "tenant-ada");
});
