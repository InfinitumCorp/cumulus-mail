import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { applyWorkerBindings } from "../cloudflare-env.ts";
import { MissingAuthSecretError, authIpOptions, authSettingsKey, isDeployedRuntime, resolveAuthSecret } from "./auth-settings.ts";

const g = globalThis as { __env__?: unknown };
const KEYS = ["BETTER_AUTH_SECRET", "DATABASE_URL", "CUMULUS_RUNTIME"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  delete g.__env__;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const preview = () => "preview-random-secret";

test("local dev and the sandbox preview may use the preview secret", () => {
  assert.equal(isDeployedRuntime({}), false);
  assert.equal(resolveAuthSecret({}, preview), "preview-random-secret");
  assert.equal(resolveAuthSecret({ BETTER_AUTH_SECRET: "  " }, preview), "preview-random-secret");
  assert.equal(resolveAuthSecret({ BETTER_AUTH_SECRET: " real " }, preview), "real");
});

test("a deployment without BETTER_AUTH_SECRET throws instead of signing with a random secret", () => {
  assert.equal(isDeployedRuntime({ DATABASE_URL: "postgres://x" }), true);
  assert.equal(isDeployedRuntime({ CUMULUS_RUNTIME: "cloudflare" }), true);
  let called = false;
  const spy = () => {
    called = true;
    return "random";
  };
  assert.throws(() => resolveAuthSecret({ DATABASE_URL: "postgres://x" }, spy), MissingAuthSecretError);
  assert.throws(() => resolveAuthSecret({ CUMULUS_RUNTIME: "cloudflare" }, spy), /BETTER_AUTH_SECRET is not set/);
  assert.equal(called, false);
  assert.equal(resolveAuthSecret({ DATABASE_URL: "postgres://x", BETTER_AUTH_SECRET: "s" }, spy), "s");
});

test("on Workers the secret is read from the bindings once they are copied, never a random one", () => {
  delete process.env.BETTER_AUTH_SECRET;
  delete process.env.DATABASE_URL;
  delete process.env.CUMULUS_RUNTIME;
  // Module load: no request yet, no bindings. Nothing reads the secret here any more.
  g.__env__ = {
    CUMULUS_RUNTIME: "cloudflare",
    BETTER_AUTH_SECRET: "secret-from-binding",
    HYPERDRIVE: { connectionString: "postgres://hyperdrive/db" },
  };
  applyWorkerBindings();
  assert.equal(resolveAuthSecret(process.env, preview), "secret-from-binding");
  assert.equal(process.env.DATABASE_URL, "postgres://hyperdrive/db");

  // A Worker whose secret binding is missing fails loudly.
  delete process.env.BETTER_AUTH_SECRET;
  g.__env__ = { CUMULUS_RUNTIME: "cloudflare" };
  applyWorkerBindings();
  assert.throws(() => resolveAuthSecret(process.env, preview), MissingAuthSecretError);
});

test("the instance is rebuilt only when a setting it depends on changes", () => {
  const a = authSettingsKey({ BETTER_AUTH_SECRET: "s", DATABASE_URL: "postgres://x" });
  assert.equal(authSettingsKey({ BETTER_AUTH_SECRET: "s", DATABASE_URL: "postgres://x", UNRELATED: "1" }), a);
  assert.notEqual(authSettingsKey({ BETTER_AUTH_SECRET: "t", DATABASE_URL: "postgres://x" }), a);
  assert.notEqual(authSettingsKey({ BETTER_AUTH_SECRET: "s" }), a);
});

test("server.ts builds Better Auth lazily: no secret, database or provider is read at module load", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./server.ts", import.meta.url), "utf8");
  const moduleLevel = source.slice(0, source.indexOf("function buildAuth("));
  assert.equal(/betterAuth\(\{/.test(moduleLevel), false, "betterAuth({...}) must be inside buildAuth()");
  assert.equal(/BETTER_AUTH_SECRET|DATABASE_URL|cidConfig\(\)/.test(moduleLevel.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "")), false);
  assert.match(source, /export function getAuth\([^)]*\)[^{]*\{[\s\S]*?applyWorkerBindings\(\)/);
  assert.match(source, /secret: resolveAuthSecret\(process\.env, previewAuthSecret\)/);
});

test("the RU issuer and region settings rebuild the instance when they change", () => {
  const base = authSettingsKey({ BETTER_AUTH_SECRET: "s" });
  assert.notEqual(authSettingsKey({ BETTER_AUTH_SECRET: "s", CID_ISSUER_RU: "https://ru.id.example" }), base);
  assert.notEqual(authSettingsKey({ BETTER_AUTH_SECRET: "s", MAIL_REGION: "ru" }), base);
});

test("authIpOptions: cf-connecting-ip on Cloudflare Workers", () => {
  assert.deepEqual(authIpOptions({ CUMULUS_RUNTIME: "cloudflare" }), { ipAddressHeaders: ["cf-connecting-ip"] });
});

test("authIpOptions: x-forwarded-for elsewhere (Yandex gateway, node server)", () => {
  assert.deepEqual(authIpOptions({}), { ipAddressHeaders: ["x-forwarded-for"] });
});

test("authIpOptions: explicit header list and trusted proxies, junk dropped", () => {
  assert.deepEqual(
    authIpOptions({
      CUMULUS_RUNTIME: "cloudflare",
      BETTER_AUTH_IP_HEADERS: " X-Real-IP , x-forwarded-for,bad header",
      BETTER_AUTH_TRUSTED_PROXIES: "10.0.0.0/8, 192.168.1.1",
    }),
    { ipAddressHeaders: ["x-real-ip", "x-forwarded-for"], trustedProxies: ["10.0.0.0/8", "192.168.1.1"] },
  );
});

test("authSettingsKey changes when the IP headers change", () => {
  assert.notEqual(authSettingsKey({ BETTER_AUTH_IP_HEADERS: "x-real-ip" }), authSettingsKey({}));
});
