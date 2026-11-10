import assert from "node:assert/strict";
import { test } from "node:test";
import { VERCEL_PRESET, WORKERS_PRESET, nitroPreset, readWorkerConfig } from "./nitro-preset.mjs";

const FORBIDDEN = [
  "send_email",
  "r2_buckets",
  "routes",
  "addresses",
  "d1_databases",
  "kv_namespaces",
];

function assertInboundSafe(config) {
  assert.equal(config.name, "cumulus-mail-inbound");
  assert.equal(config.workers_dev, false);
  assert.deepEqual(config.compatibility_flags, ["nodejs_compat"]);
  assert.equal(config.hyperdrive?.[0]?.binding, "HYPERDRIVE");
  assert.equal(config.hyperdrive?.[0]?.id, "REPLACE_WITH_HYPERDRIVE_ID");
  assert.equal(config.vars.SUPABASE_S3_BUCKET, "cumulus-mail");
  assert.equal(
    config.vars.SUPABASE_S3_ENDPOINT,
    "https://ivqiskeziohbbtkcvlun.supabase.co/storage/v1/s3",
  );
  assert.equal(config.vars.CUMULUS_ALLOW_SUPABASE, "1");
  assert.equal(config.observability?.enabled, true);
  assert.equal(config.observability?.traces?.enabled, true);
  for (const key of FORBIDDEN) assert.equal(config[key], undefined, key);
  assert.equal(JSON.stringify(config).includes("REPLACE_WITH_HYPERDRIVE_ID"), true);
  assert.equal(JSON.stringify(config).includes("AKIA"), false);
}

function assertApiSafe(config) {
  assert.equal(config.name, "cumulus-mail-api");
  assert.notEqual(config.name, "cumulus-mail");
  assert.equal(config.workers_dev, true);
  assert.equal(config.vars.CUMULUS_RUNTIME, "cloudflare");
  assert.equal(config.vars.MAIL_STORAGE, "s3");
  assert.equal(
    config.vars.CUMULUS_OIDC_ISSUER,
    "https://id.cumuluscloud.app/realms/cumulus",
  );
  assert.equal(config.hyperdrive?.[0]?.binding, "HYPERDRIVE");
  assert.equal(config.routes, undefined);
  assert.equal(config.workers_dev, true);
  for (const key of FORBIDDEN) assert.equal(config[key], undefined, key);
}

test("the default Nitro preset stays vercel and workers is opt-in", () => {
  assert.equal(nitroPreset({}), VERCEL_PRESET);
  assert.equal(nitroPreset({ NITRO_PRESET: "" }), VERCEL_PRESET);
  assert.equal(nitroPreset({ NITRO_PRESET: WORKERS_PRESET }), WORKERS_PRESET);
  assert.throws(() => nitroPreset({ NITRO_PRESET: "cloudflare-pages" }), /cloudflare-module/);
});

test("inbound and API wrangler files stay off the live page worker", () => {
  assertInboundSafe(readWorkerConfig("workers/email/wrangler.jsonc"));
  assertApiSafe(readWorkerConfig("workers/api/wrangler.jsonc"));
});
