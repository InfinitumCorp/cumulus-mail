import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CUMULUS_ID_CREATE_PROVIDER_ID,
  CUMULUS_ID_PROVIDER_ID,
  DEFAULT_CID_CLIENT_ID,
  DEFAULT_CID_ISSUER,
  SIGN_IN_PROVIDERS,
  cidConfig,
  cidProfileFromTokens,
  cidUserInfo,
  exchangeCidCode,
} from "./cumulus-id.ts";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Cumulus ID sign-in", () => {
  it("offers only Cumulus ID: sign in, then create", () => {
    assert.deepEqual(
      SIGN_IN_PROVIDERS.map((p) => [p.providerId, p.label, p.create]),
      [
        [CUMULUS_ID_PROVIDER_ID, "Sign in with Cumulus ID", false],
        [CUMULUS_ID_CREATE_PROVIDER_ID, "Create a Cumulus ID", true],
      ],
    );
  });

  it("defaults to id.cumuluscloud.app and the cumulus-mail client", () => {
    assert.deepEqual(cidConfig({}), { issuer: DEFAULT_CID_ISSUER, clientId: DEFAULT_CID_CLIENT_ID });
    assert.equal(DEFAULT_CID_ISSUER, "https://id.cumuluscloud.app");
  });

  it("takes a mirror issuer from CID_ISSUER", () => {
    assert.deepEqual(cidConfig({ CID_ISSUER: " https://ru.mail.cumuluscloud.app/ ", CID_CLIENT_ID: "x" }), {
      issuer: "https://ru.mail.cumuluscloud.app",
      clientId: "x",
    });
  });

  it("redeems the code with PKCE as JSON and keeps the profile", async () => {
    let seen: { url: string; body: Record<string, unknown> } | null = null;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(String(init.body)) };
      return json(200, {
        access_token: "opaque-token-abcdefghijklmnop",
        expires_in: 3600,
        profile: { cid: "cid_1", username: "alex", email: "alex@cumuluscloud.app" },
      });
    }) as unknown as typeof fetch;
    const config = cidConfig({});
    const tokens = await exchangeCidCode(
      config,
      { code: "c", codeVerifier: "v", redirectURI: "https://mail.cumuluscloud.app/api/auth/callback/cumulus-id" },
      fake,
    );
    assert.deepEqual(seen, {
      url: "https://id.cumuluscloud.app/api/id/token",
      body: {
        code: "c",
        code_verifier: "v",
        client_id: "cumulus-mail",
        redirect_uri: "https://mail.cumuluscloud.app/api/auth/callback/cumulus-id",
      },
    });
    assert.equal(tokens.accessToken, "opaque-token-abcdefghijklmnop");
    assert.ok(tokens.accessTokenExpiresAt instanceof Date);
    const profile = await cidProfileFromTokens(config, tokens, (() => {
      throw new Error("no userinfo call expected");
    }) as unknown as typeof fetch);
    assert.deepEqual(cidUserInfo(profile!), {
      id: "cid_1",
      sub: "cid_1",
      email: "alex@cumuluscloud.app",
      emailVerified: true,
      name: "alex",
    });
  });

  it("refuses a code without a verifier or a rejected code", async () => {
    const config = cidConfig({});
    await assert.rejects(exchangeCidCode(config, { code: "c", redirectURI: "r" }), /PKCE/);
    const reject = (async () => json(400, { error: "Invalid code" })) as unknown as typeof fetch;
    await assert.rejects(exchangeCidCode(config, { code: "c", codeVerifier: "v", redirectURI: "r" }, reject), /Invalid code/);
  });

  it("falls back to /api/id/userinfo when the token carried no profile", async () => {
    const fake = (async (url: string, init: RequestInit) => {
      assert.equal(url, "https://id.cumuluscloud.app/api/id/userinfo");
      assert.equal((init.headers as Record<string, string>).authorization, "Bearer t");
      return json(200, { cid: "cid_2", name: "Sam" });
    }) as unknown as typeof fetch;
    const profile = await cidProfileFromTokens(cidConfig({}), { accessToken: "t", raw: {} }, fake);
    assert.equal(profile?.cid, "cid_2");
    assert.equal(cidUserInfo(profile!).emailVerified, false);
  });
});

describe("Cumulus ID per region", () => {
  it("ru.* hosts sign in through the Russia mirror; everyone else through id.cumuluscloud.app", async () => {
    const { cidConfigForRegion, DEFAULT_CID_ISSUER_RU } = await import("./cumulus-id.ts");
    const { regionFor } = await import("../region.ts");
    assert.equal(DEFAULT_CID_ISSUER_RU, "https://ru.id.cumuluscloud.app");
    assert.deepEqual(cidConfigForRegion(regionFor("mail.cumuluscloud.app", {}), {}), {
      issuer: DEFAULT_CID_ISSUER,
      clientId: DEFAULT_CID_CLIENT_ID,
    });
    assert.deepEqual(cidConfigForRegion(regionFor("ru.mail.cumuluscloud.app", {}), {}), {
      issuer: "https://ru.id.cumuluscloud.app",
      clientId: DEFAULT_CID_CLIENT_ID,
    });
    // CID_ISSUER_RU overrides the mirror; CID_ISSUER only ever applies outside Russia.
    const env = { CID_ISSUER: "https://id.example", CID_ISSUER_RU: "https://ru.id.example/", CID_CLIENT_ID: "mail" };
    assert.deepEqual(cidConfigForRegion("ru", env), { issuer: "https://ru.id.example", clientId: "mail" });
    assert.deepEqual(cidConfigForRegion("us", env), { issuer: "https://id.example", clientId: "mail" });
    // The Russia deployment (MAIL_REGION=ru) uses the mirror whatever host it is reached on.
    assert.equal(cidConfigForRegion(regionFor("cumulus-mail-ru.example", { MAIL_REGION: "ru" }), {}).issuer, DEFAULT_CID_ISSUER_RU);
  });
});
