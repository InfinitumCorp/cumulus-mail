import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { smokePlan } from "./smoke.mjs";

const GATES = [
  "MAIL_S3_ENDPOINT",
  "MAIL_S3_BUCKET",
  "MAIL_S3_ACCESS_KEY_ID",
  "MAIL_S3_SECRET_ACCESS_KEY",
  "MAIL_S3_REGION",
  "MAIL_S3_LOOPBACK_ONLY",
  "CUMULUS_ALLOW_SUPABASE",
  "DATABASE_URL",
  "MAIL_RUNTIME_DATABASE_URL",
  "CUMULUS_OIDC_ISSUER",
];

function quietEnv() {
  const env = { ...process.env };
  for (const name of GATES) delete env[name];
  return env;
}

test("smoke plans nothing when the environment is empty", () => {
  assert.deepEqual(smokePlan({}), { storage: false, database: false, oidc: false });
  assert.equal(smokePlan({ DATABASE_URL: "postgres://db.example/mail" }).database, true);
  assert.equal(smokePlan({ CUMULUS_OIDC_ISSUER: "https://id.example/realms/cumulus" }).oidc, true);
  assert.equal(
    smokePlan({
      MAIL_S3_ENDPOINT: "https://example.supabase.co/storage/v1/s3",
      MAIL_S3_BUCKET: "cumulus-mail",
      MAIL_S3_ACCESS_KEY_ID: "key",
      MAIL_S3_SECRET_ACCESS_KEY: "secret",
    }).storage,
    true,
  );
});

test("smoke skips cleanly when environment variables are unset", async () => {
  const child = spawn(process.execPath, ["scripts/smoke.mjs"], {
    env: quietEnv(),
    cwd: fileURLToPath(new URL("..", import.meta.url)),
  });
  let out = "";
  child.stdout.on("data", (chunk) => {
    out += chunk;
  });
  child.stderr.on("data", (chunk) => {
    out += chunk;
  });
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  assert.equal(code, 0);
  assert.match(out, /storage skipped/);
  assert.match(out, /database skipped/);
  assert.match(out, /oidc skipped/);
  assert.doesNotMatch(out, /https?:\/\//);
});
