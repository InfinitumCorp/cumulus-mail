import assert from "node:assert/strict";
import { test } from "node:test";
import { DeployGuardError, guardConfig } from "./deploy-guard.mjs";
import { readWorkerConfig } from "./nitro-preset.mjs";

const HD = "0123456789abcdef0123456789abcdef";

test("the committed inbound config passes once a real Hyperdrive id is supplied", () => {
  const config = readWorkerConfig("workers/email/wrangler.jsonc");
  assert.throws(() => guardConfig("inbound", config), /placeholder/);
  assert.throws(() => guardConfig("inbound", config, { hyperdriveId: "not-an-id" }), /32-character/);
  const out = guardConfig("inbound", config, { hyperdriveId: HD });
  assert.equal(out.name, "cumulus-mail-inbound");
  assert.equal(out.hyperdrive[0].id, HD);
  // The committed file is not changed.
  assert.equal(config.hyperdrive[0].id, "REPLACE_WITH_HYPERDRIVE_ID");
});

test("never the page worker cumulus-mail, and the name must match the target", () => {
  const base = { name: "cumulus-mail", workers_dev: false, hyperdrive: [{ binding: "HYPERDRIVE", id: HD }] };
  assert.throws(() => guardConfig("inbound", base), /refusing to deploy over the page worker/);
  assert.throws(() => guardConfig("api", { ...base, name: "cumulus-mail-inbound", workers_dev: true }), /expected "cumulus-mail-api"/);
  assert.throws(() => guardConfig("pages", base), DeployGuardError);
});

test("no routes, custom domains, Email Routing, send_email or R2, at the top level or in env overrides", () => {
  const ok = { name: "cumulus-mail-api", workers_dev: true, hyperdrive: [{ binding: "HYPERDRIVE", id: HD }] };
  assert.doesNotThrow(() => guardConfig("api", ok));
  for (const [key, value] of [
    ["routes", [{ pattern: "mail.cumuluscloud.app/*" }]],
    ["route", "mail.cumuluscloud.app/*"],
    ["custom_domains", ["mail.cumuluscloud.app"]],
    ["addresses", ["*@cumuluscloud.app"]],
    ["send_email", [{ name: "SEND" }]],
    ["r2_buckets", [{ binding: "R2" }]],
  ]) {
    assert.throws(() => guardConfig("api", { ...ok, [key]: value }), new RegExp(`"${key}" is not allowed`));
    assert.throws(() => guardConfig("api", { ...ok, env: { production: { [key]: value } } }), /env overrides/);
  }
});

test("the inbound worker stays off workers.dev and the API worker stays on it", () => {
  const inbound = { name: "cumulus-mail-inbound", workers_dev: true, hyperdrive: [{ binding: "HYPERDRIVE", id: HD }] };
  assert.throws(() => guardConfig("inbound", inbound), /workers_dev must be false/);
  assert.throws(() => guardConfig("api", { ...inbound, name: "cumulus-mail-api", workers_dev: false }), /workers_dev must be true/);
});

test("deploy workflows run only by hand, in a reviewed environment, through the guard", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { projectRoot } = await import("./nitro-preset.mjs");
  const dir = join(projectRoot(), ".github/workflows");
  const deploys = readdirSync(dir).filter((file) => file.startsWith("deploy-"));
  assert.ok(deploys.includes("deploy-cloudflare.yml"));
  for (const file of deploys) {
    const text = readFileSync(join(dir, file), "utf8");
    const on = text.slice(text.indexOf("\non:"), text.indexOf("\n", text.indexOf("\non:") + 5) + 200);
    assert.match(text, /\non:\n {2}workflow_dispatch:/, `${file} must be manual`);
    assert.equal(/\n {2}(push|pull_request|pull_request_target|schedule|workflow_run):/.test(on), false, `${file} must not run on push`);
    assert.match(text, /\n {4}environment: production-(us|ru)\n/, `${file} must use a reviewed environment`);
    assert.match(text, /if: github\.ref == 'refs\/heads\/main'/, `${file} deploys main only`);
  }
  const cloudflare = readFileSync(join(dir, "deploy-cloudflare.yml"), "utf8");
  assert.match(cloudflare, /node scripts\/deploy-guard\.mjs inbound/);
  assert.match(cloudflare, /node scripts\/deploy-guard\.mjs api/);
  assert.equal(/deploy --config wrangler\.jsonc|wrangler(@[\d.]+)? deploy\s*$/m.test(cloudflare), false, "deploy only the guarded copy");
  assert.equal(/email routing|catch-all/i.test(cloudflare.replace(/^#.*$/gm, "")), false);
});
