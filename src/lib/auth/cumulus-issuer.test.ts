import assert from "node:assert/strict";
import { test } from "node:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import {
  createLocalJWKSet,
  cumulusDiscoveryUrl,
  cumulusIssuer,
  cumulusJwksUrl,
  fetchCumulusJwks,
  verifyCumulusToken,
} from "./cumulus-issuer.ts";
import { GOOGLE_PROVIDER_ID, SIGN_IN_PROVIDERS, googleConfig } from "./providers.ts";

const ISSUER = "https://id.example";

test("Google is the only sign-in method, and it is off until both client values are set", () => {
  assert.deepEqual(
    SIGN_IN_PROVIDERS.map((p) => [p.providerId, p.label]),
    [[GOOGLE_PROVIDER_ID, "Sign in with Google"]],
  );
  assert.equal(googleConfig({}), null);
  assert.equal(googleConfig({ GOOGLE_CLIENT_ID: "id.apps.googleusercontent.com" }), null);
  assert.equal(googleConfig({ GOOGLE_CLIENT_ID: " ", GOOGLE_CLIENT_SECRET: "s" }), null);
  assert.deepEqual(googleConfig({ GOOGLE_CLIENT_ID: " id ", GOOGLE_CLIENT_SECRET: " s " }), {
    clientId: "id",
    clientSecret: "s",
  });
});

test("there is no default issuer: cross-app bearer tokens are off unless one is named", () => {
  assert.equal(cumulusIssuer({}), null);
  assert.equal(cumulusIssuer({ CUMULUS_OIDC_ISSUER: "  " }), null);
  assert.equal(cumulusIssuer({ CUMULUS_OIDC_ISSUER: " https://id.example/realms/cumulus/ " }), "https://id.example/realms/cumulus");
});

test("discovery and JWKS hang off the issuer, with the Keycloak path kept for a realm", () => {
  assert.equal(cumulusDiscoveryUrl(ISSUER), `${ISSUER}/.well-known/openid-configuration`);
  assert.equal(cumulusJwksUrl(ISSUER, {}), `${ISSUER}/.well-known/jwks.json`);
  assert.equal(
    cumulusJwksUrl("https://id.example/realms/cumulus", {}),
    "https://id.example/realms/cumulus/protocol/openid-connect/certs",
  );
  assert.equal(cumulusJwksUrl(ISSUER, { CUMULUS_OIDC_JWKS_URL: "https://keys.example/jwks" }), "https://keys.example/jwks");
});

test("JWKS comes from discovery, and a document for another issuer is refused", async () => {
  const calls: string[] = [];
  const respond = (body: unknown, ok = true) =>
    ({ ok, status: ok ? 200 : 500, json: async () => body }) as unknown as Response;

  const keys = await fetchCumulusJwks(ISSUER, {
    env: {},
    fetch: (async (input: string) => {
      calls.push(String(input));
      if (String(input).endsWith("/.well-known/openid-configuration")) {
        return respond({ issuer: ISSUER, jwks_uri: "https://keys.example/jwks.json" });
      }
      return respond({ keys: [{ kid: "from-discovery" }] });
    }) as unknown as typeof fetch,
  });
  assert.deepEqual(calls, [`${ISSUER}/.well-known/openid-configuration`, "https://keys.example/jwks.json"]);
  assert.deepEqual(keys, { keys: [{ kid: "from-discovery" }] });

  await assert.rejects(
    () =>
      fetchCumulusJwks(ISSUER, {
        env: {},
        fetch: (async () => respond({ issuer: "https://evil.example", jwks_uri: "https://evil.example/jwks" })) as unknown as typeof fetch,
      }),
    /another issuer/,
  );

  const fallback: string[] = [];
  await fetchCumulusJwks(ISSUER, {
    env: {},
    fetch: (async (input: string) => {
      fallback.push(String(input));
      if (String(input).endsWith("/.well-known/openid-configuration")) throw new Error("offline");
      return respond({ keys: [] });
    }) as unknown as typeof fetch,
  });
  assert.equal(fallback[1], `${ISSUER}/.well-known/jwks.json`);
});

test("the tenant comes only from the verified tenant_id claim", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "mail-test";
  const keys = createLocalJWKSet({ keys: [jwk] });
  const sign = (claims: Record<string, unknown>, issuer = ISSUER) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "mail-test" })
      .setIssuer(issuer)
      .setSubject("user-ada")
      .setExpirationTime("2h")
      .sign(privateKey);

  const token = await sign({ tenant_id: "tenant-a" });
  const verified = await verifyCumulusToken(token, { issuer: ISSUER, keys });
  assert.equal(verified.tenantId, "tenant-a");
  assert.equal(verified.subject, "user-ada");

  const wrongIssuer = await sign({ tenant_id: "tenant-a" }, "https://evil.example");
  await assert.rejects(() => verifyCumulusToken(wrongIssuer, { issuer: ISSUER, keys }));
  // No Cognito-style fallback: a token without tenant_id is refused, even with a custom claim or a subject.
  await assert.rejects(async () => verifyCumulusToken(await sign({ "custom:tenant_id": "tenant-b" }), { issuer: ISSUER, keys }), /tenant_id/);
  await assert.rejects(async () => verifyCumulusToken(await sign({}), { issuer: ISSUER, keys }), /tenant_id/);
  await assert.rejects(async () => verifyCumulusToken(`${token.slice(0, -4)}aaaa`, { issuer: ISSUER, keys }));
});
