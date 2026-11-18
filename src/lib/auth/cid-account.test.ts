import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CUMULUS_ID_ACCOUNT_URL,
  listCidSessions,
  lookupCidMailKeys,
  publishCidMailKey,
  recipientKeys,
  revokeCidSession,
  revokeOtherCidSessions,
  tokenUsable,
  withdrawCidMailKey,
} from "./cid-account.ts";

const ISSUER = "https://id.cumuluscloud.app";
const KEY = "-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nxjMEZ...\n-----END PGP PUBLIC KEY BLOCK-----";

type Seen = { url: string; method: string; auth: string | null; body: unknown };

function fakeFetch(status: number, body: unknown, seen: Seen[] = []) {
  return (async (input: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    seen.push({
      url: String(input),
      method: init.method ?? "GET",
      auth: headers.get("authorization"),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

const call = (fetchImpl: typeof globalThis.fetch, extra: Record<string, unknown> = {}) => ({
  issuer: `${ISSUER}/`,
  accessToken: "a.b.c",
  accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
  fetch: fetchImpl,
  ...extra,
});

test("sessions are listed with the stored bearer token, current first", async () => {
  const seen: Seen[] = [];
  const result = await listCidSessions(
    call(
      fakeFetch(
        200,
        {
          sessions: [
            { id: "ses_old", kind: "console", client: null, method: "passkey", device: "Safari on macOS", country: "DE", createdAt: "2026-11-01T00:00:00Z", lastSeenAt: "2026-11-02T00:00:00Z", current: false },
            { id: "ses_mail", kind: "app", client: { id: "cumulus-mail", name: "Cumulus://Mail" }, method: "passkey", device: "Chrome on Windows", country: "US", createdAt: "2026-11-10T00:00:00Z", lastSeenAt: "2026-11-10T00:00:00Z", current: true },
            { id: "bad id/../", kind: "app", current: false },
          ],
        },
        seen,
      ),
    ),
  );
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(
    result.value.map((s) => [s.id, s.client, s.current]),
    [
      ["ses_mail", "Cumulus://Mail", true],
      ["ses_old", null, false],
    ],
  );
  assert.equal(result.value[0]?.device, "Chrome on Windows");
  assert.deepEqual(seen, [{ url: `${ISSUER}/api/id/sessions`, method: "GET", auth: "Bearer a.b.c", body: undefined }]);
});

test("an expired, missing or revoked token is 'signed-out' with the account link, not an error", async () => {
  const seen: Seen[] = [];
  const expired = await listCidSessions(call(fakeFetch(200, {}, seen), { accessTokenExpiresAt: new Date(Date.now() - 1000) }));
  assert.deepEqual(expired, { status: "signed-out", accountUrl: CUMULUS_ID_ACCOUNT_URL });
  const missing = await listCidSessions(call(fakeFetch(200, {}, seen), { accessToken: null }));
  assert.equal(missing.status, "signed-out");
  assert.equal(seen.length, 0, "no call is made without a usable token");

  const revoked = await listCidSessions(call(fakeFetch(401, { error: "invalid_token" })));
  assert.deepEqual(revoked, { status: "signed-out", accountUrl: "https://id.cumuluscloud.app/account" });

  const down = await listCidSessions(
    call((async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch),
  );
  assert.equal(down.status, "error");

  assert.equal(tokenUsable("t", null), true);
  assert.equal(tokenUsable("t", new Date(Date.now() + 2_000)), false);
});

test("sign out one session and everywhere else", async () => {
  const seen: Seen[] = [];
  assert.deepEqual(await revokeCidSession(call(fakeFetch(200, { ok: true }, seen)), "ses_old"), { status: "ok", value: true });
  assert.deepEqual(await revokeOtherCidSessions(call(fakeFetch(200, { ended: 3 }, seen))), { status: "ok", value: 3 });
  assert.deepEqual(
    seen.map((s) => [s.method, s.url]),
    [
      ["DELETE", `${ISSUER}/api/id/sessions/ses_old`],
      ["POST", `${ISSUER}/api/id/sessions/revoke-others`],
    ],
  );

  const gone = await revokeCidSession(call(fakeFetch(404, { error: "not_found", error_description: "That session has already ended." })), "ses_x");
  assert.deepEqual(gone, { status: "error", message: "That session has already ended." });
  // An id that could change the path is refused before any call.
  const before = seen.length;
  assert.equal((await revokeCidSession(call(fakeFetch(200, {}, seen)), "../keys")).status, "error");
  assert.equal(seen.length, before);
});

test("publish and withdraw a public key on the directory", async () => {
  const seen: Seen[] = [];
  const published = await publishCidMailKey(
    call(fakeFetch(200, { key: { id: "key_1", address: "ada@cumuluscloud.app", fingerprint: "ABCD", createdAt: "2026-11-12T00:00:00Z" } }, seen)),
    `  ${KEY}\n`,
  );
  assert.deepEqual(published, {
    status: "ok",
    value: { id: "key_1", address: "ada@cumuluscloud.app", fingerprint: "ABCD", createdAt: "2026-11-12T00:00:00Z" },
  });
  assert.deepEqual(seen[0], { url: `${ISSUER}/api/id/keys`, method: "POST", auth: "Bearer a.b.c", body: { armored: KEY } });

  const privateKey = await publishCidMailKey(call(fakeFetch(200, {})), "-----BEGIN PGP PRIVATE KEY BLOCK-----\n...");
  assert.equal(privateKey.status, "error", "a private key is never sent");

  const wrongUid = await publishCidMailKey(
    call(fakeFetch(400, { error: "invalid_key", error_description: "The key has no user ID for ada@cumuluscloud.app." })),
    KEY,
  );
  assert.deepEqual(wrongUid, { status: "error", message: "The key has no user ID for ada@cumuluscloud.app." });

  assert.deepEqual(await withdrawCidMailKey(call(fakeFetch(200, { ok: true }, seen)), "key_1"), { status: "ok", value: true });
  assert.deepEqual([seen[1]?.method, seen[1]?.url], ["DELETE", `${ISSUER}/api/id/keys/key_1`]);
});

test("directory lookup is public, filed by address, and never throws", async () => {
  const seen: Seen[] = [];
  const keys = await lookupCidMailKeys(
    ISSUER,
    " Bob@CumulusCloud.app ",
    fakeFetch(
      200,
      {
        keys: [
          { address: "bob@cumuluscloud.app", fingerprint: "F1", armored: KEY, createdAt: "x" },
          { address: "eve@cumuluscloud.app", fingerprint: "F2", armored: KEY },
          { address: "bob@cumuluscloud.app", fingerprint: "F3", armored: "not a key" },
        ],
      },
      seen,
    ),
  );
  assert.deepEqual(keys, [{ address: "bob@cumuluscloud.app", fingerprint: "F1", armored: KEY }]);
  assert.deepEqual(seen, [
    { url: `${ISSUER}/api/id/keys?address=bob%40cumuluscloud.app`, method: "GET", auth: null, body: undefined },
  ]);

  assert.deepEqual(await lookupCidMailKeys(ISSUER, "bob@cumuluscloud.app", fakeFetch(500, {})), []);
  assert.deepEqual(
    await lookupCidMailKeys(ISSUER, "bob@cumuluscloud.app", (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch),
    [],
  );
  assert.deepEqual(await lookupCidMailKeys(ISSUER, "not-an-address", fakeFetch(200, { keys: [] })), []);
});

test("recipient keys: directory first, then the contact key, else no encryption", () => {
  const contacts: Record<string, string> = { "carol@example.com": "CAROL", "bob@cumuluscloud.app": "BOB-CONTACT" };
  const contactKey = (address: string) => contacts[address];
  const directory = { "bob@cumuluscloud.app": ["BOB-DIR-1", "BOB-DIR-2"] };

  assert.deepEqual(recipientKeys(["Bob@cumuluscloud.app", "carol@example.com"], directory, contactKey), ["BOB-DIR-1", "BOB-DIR-2", "CAROL"]);
  assert.deepEqual(recipientKeys(["bob@cumuluscloud.app"], {}, contactKey), ["BOB-CONTACT"]);
  assert.equal(recipientKeys(["bob@cumuluscloud.app", "dave@example.com"], directory, contactKey), null);
  assert.equal(recipientKeys([], directory, contactKey), null);
});
