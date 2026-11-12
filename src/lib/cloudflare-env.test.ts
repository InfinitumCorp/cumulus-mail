import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { applyWorkerBindings, isCopiedBinding } from "./cloudflare-env.ts";

const g = globalThis as { __env__?: unknown };
const touched = ["MAIL_SMTP_HOST", "MAIL_OUTBOUND_DAILY_LIMIT", "STRIPE_SECRET_KEY", "MAIL_DEFAULT_PLAN", "UNRELATED_TOKEN", "DATABASE_URL", "MAIL_EMPTY"];
const saved = Object.fromEntries(touched.map((k) => [k, process.env[k]]));

afterEach(() => {
  delete g.__env__;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("this app's settings are copied by prefix; unrelated bindings are not", () => {
  for (const name of [
    "MAIL_BLOB_KEY",
    "MAIL_SMTP_HOST",
    "MAIL_SMTP_PASSWORD",
    "MAIL_DKIM_DOMAIN",
    "MAIL_OUTBOUND_HOURLY_LIMIT",
    "MAIL_DEFAULT_PLAN",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "BILLING_RETURN_URL",
    "GOOGLE_CLIENT_ID",
    "CID_ISSUER",
    "CUMULUS_OIDC_ISSUER",
    "BETTER_AUTH_SECRET",
    "VITE_AUTH_ENABLED",
  ]) {
    assert.equal(isCopiedBinding(name), true, name);
  }
  for (const name of ["HYPERDRIVE", "UNRELATED_TOKEN", "GOOGLE_API_KEY", "PATH", "mail_smtp_host"]) {
    assert.equal(isCopiedBinding(name), false, name);
  }
});

test("applyWorkerBindings copies string settings from the Worker env, and Hyperdrive as DATABASE_URL", () => {
  g.__env__ = {
    HYPERDRIVE: { connectionString: "postgres://h/db" },
    MAIL_SMTP_HOST: "smtp.example.com",
    MAIL_OUTBOUND_DAILY_LIMIT: "250",
    STRIPE_SECRET_KEY: "sk_test_x",
    MAIL_DEFAULT_PLAN: "free",
    MAIL_EMPTY: "",
    UNRELATED_TOKEN: "nope",
  };
  delete process.env.UNRELATED_TOKEN;
  delete process.env.MAIL_EMPTY;
  applyWorkerBindings();
  assert.equal(process.env.DATABASE_URL, "postgres://h/db");
  assert.equal(process.env.MAIL_SMTP_HOST, "smtp.example.com");
  assert.equal(process.env.MAIL_OUTBOUND_DAILY_LIMIT, "250");
  assert.equal(process.env.STRIPE_SECRET_KEY, "sk_test_x");
  assert.equal(process.env.MAIL_DEFAULT_PLAN, "free");
  assert.equal(process.env.MAIL_EMPTY, undefined);
  assert.equal(process.env.UNRELATED_TOKEN, undefined);
});
