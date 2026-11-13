import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { projectRoot } from "./nitro-preset.mjs";

const read = (path) => readFileSync(join(projectRoot(), path), "utf8");
const SECRETS = [
  "BETTER_AUTH_SECRET",
  "DATABASE_URL",
  "MAIL_BLOB_KEY",
  "MAIL_S3_ACCESS_KEY_ID",
  "MAIL_S3_SECRET_ACCESS_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "MAIL_SMTP_PASSWORD",
  "MAIL_DKIM_PRIVATE_KEY",
  "CRON_SECRET",
];

test("the Russia image builds the Node server and bakes no secret into the image", () => {
  const dockerfile = read("Dockerfile");
  assert.match(dockerfile, /npm run build:node/);
  assert.match(dockerfile, /CMD \["node", "\.output\/server\/index\.mjs"\]/);
  assert.match(dockerfile, /^USER node$/m);
  for (const name of SECRETS) {
    assert.equal(new RegExp(`(ENV|ARG)\\s+${name}\\b`).test(dockerfile), false, `${name} must not be in the Dockerfile`);
  }
  assert.match(read(".dockerignore"), /^\.env$/m);
});

test("the RU settings file has region ru-central1, Yandex storage, the ru host and no secret values", () => {
  const env = read("deploy/yandex/ru.env.example");
  const plain = Object.fromEntries(
    env
      .split("\n")
      .filter((line) => /^[A-Z_][A-Z0-9_]*=/.test(line))
      .map((line) => line.split(/=(.*)/s).slice(0, 2)),
  );
  assert.equal(plain.MAIL_S3_REGION, "ru-central1");
  assert.equal(plain.MAIL_S3_ENDPOINT, "https://storage.yandexcloud.net");
  assert.equal(plain.BETTER_AUTH_URL, "https://ru.mail.cumuluscloud.app");
  assert.equal(plain.MAIL_APP_HOST, "ru.mail.cumuluscloud.app");
  // Not behind Cloudflare, and never the US worker host.
  assert.equal(/cloudflare|workers\.dev/i.test(JSON.stringify(plain)), false);
  for (const name of SECRETS) assert.equal(name in plain, false, `${name} must come from Lockbox`);
});

test("the deploy script asks before acting and takes secrets only as Lockbox references", () => {
  const script = read("deploy/yandex/deploy.sh");
  assert.match(script, /read -r -p "Deploy this image/);
  // Only the reviewed CI workflow skips the prompt, by setting YES=1.
  assert.match(script, /if \[ "\$\{YES:-\}" != "1" \]; then/);
  assert.match(script, /--environment "MAIL_REGION=ru"/);
  assert.match(script, /--secret "environment-variable=\$\{key\},id=\$\{LOCKBOX_ID\},key=\$\{key\}"/);
  assert.equal(/wrangler|api\.cloudflare\.com/.test(script), false);
  // Optional Lockbox keys (key rotation) are an allowlist; anything else stops the deploy.
  assert.match(script, /for key in \$\{LOCKBOX_OPTIONAL_KEYS:-\}; do/);
  assert.match(script, /MAIL_BLOB_KEYS\|MAIL_BLIND_KEY\) secret_args\+=/);
  assert.match(script, /is not an optional key" >&2; exit 1/);
});

test("the RU deploy workflow is manual, main-only, reviewed, and keeps app secrets in Lockbox", () => {
  const text = read(".github/workflows/deploy-yandex.yml");
  assert.match(text, /\non:\n {2}workflow_dispatch:/);
  assert.equal(/\n {2}(push|pull_request|pull_request_target|schedule|workflow_run):/.test(text), false);
  assert.match(text, /\n {4}environment: production-ru\n/);
  assert.match(text, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(text, /if: inputs\.confirm != 'deploy ru'/);
  assert.match(text, /run: \.\/deploy\/yandex\/deploy\.sh/);
  // The only GitHub secret is the deploy key; the app's secrets never pass through GitHub.
  const secrets = [...text.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(secrets)], ["YC_SA_KEY_JSON"]);
  assert.match(text, /rm -f "\$key"/);
});
