import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { INBOUND_MAIN_MODULE, buildInbound, inboundSchedules, inboundScriptMetadata } from "./build-inbound.mjs";
import { projectRoot, readWorkerConfig } from "./nitro-preset.mjs";

test("inbound upload metadata matches the worker config and carries no secrets", () => {
  const wrangler = readWorkerConfig("workers/email/wrangler.jsonc");
  const metadata = inboundScriptMetadata(wrangler);
  assert.equal(metadata.main_module, INBOUND_MAIN_MODULE);
  assert.equal(metadata.compatibility_date, wrangler.compatibility_date);
  assert.deepEqual(metadata.compatibility_flags, ["nodejs_compat"]);
  const names = metadata.bindings.map((binding) => binding.name);
  assert.deepEqual(names, [
    "HYPERDRIVE",
    "MAIL_DOMAIN",
    "MAIL_APP_HOST",
    "CUMULUS_ALLOW_SUPABASE",
    "SUPABASE_S3_ENDPOINT",
    "SUPABASE_S3_REGION",
    "SUPABASE_S3_BUCKET",
    "MAIL_BLOB_KEY",
    "SUPABASE_S3_ACCESS_KEY_ID",
    "SUPABASE_S3_SECRET_ACCESS_KEY",
  ]);
  assert.equal(metadata.bindings[0].type, "hyperdrive");
  assert.equal(metadata.bindings[0].id, "REPLACE_WITH_HYPERDRIVE_ID");
  for (const binding of metadata.bindings.filter((item) => item.type === "secret_text")) {
    assert.equal(binding.text, undefined);
  }
  const encoded = JSON.stringify(metadata);
  assert.equal(encoded.includes("send_email"), false);
  assert.equal(encoded.includes("r2_bucket"), false);
  assert.equal(encoded.includes("routes"), false);
});

test("the inbound worker runs the scheduled-send cron every minute", () => {
  const wrangler = readWorkerConfig("workers/email/wrangler.jsonc");
  assert.deepEqual(inboundSchedules(wrangler), [{ cron: "* * * * *" }]);
  assert.deepEqual(inboundSchedules({}), []);
});

test("build:inbound writes one ESM module and the upload metadata", async () => {
  const { outDir, metadata, schedules } = await buildInbound();
  const source = await readFile(join(outDir, INBOUND_MAIN_MODULE), "utf8");
  const written = JSON.parse(await readFile(join(outDir, "metadata.json"), "utf8"));
  assert.deepEqual(written, metadata);
  assert.deepEqual((await readdir(outDir)).sort(), ["index.js", "metadata.json", "schedules.json"]);
  assert.deepEqual(JSON.parse(await readFile(join(outDir, "schedules.json"), "utf8")), schedules);
  assert.match(source, /export\s*\{[^}]*\bas default\b/);
  assert.match(source, /\bemail\b/);
  assert.match(source, /\bscheduled\b/);
  assert.equal(source.includes("send_email"), false);
  assert.equal(join(projectRoot(), "dist/inbound"), outDir);
});
