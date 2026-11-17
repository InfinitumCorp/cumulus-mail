import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { checkDns, checkEnv, checkRepo, dkimPublicKey, report } from "./preflight.mjs";

const KEY = "ab".repeat(32);
const levels = (findings) => Object.fromEntries(findings.map((f) => [f.what, f.level]));
const missingNames = (findings) => findings.filter((f) => f.level === "missing").map((f) => f.what);

const US_READY = {
  BETTER_AUTH_SECRET: "s".repeat(40),
  MAIL_BLOB_KEY: KEY,
  MAIL_BLIND_KEY: KEY,
  BETTER_AUTH_URL: "https://cumulus-mail-api.example.workers.dev",
  SUPABASE_S3_ACCESS_KEY_ID: "id",
  SUPABASE_S3_SECRET_ACCESS_KEY: "secret",
  MAIL_AUTH_DNS: "live",
};

test("an empty US environment lists every required setting as missing", () => {
  const missing = missingNames(checkEnv({}, { region: "us" }));
  for (const name of ["BETTER_AUTH_SECRET", "MAIL_BLOB_KEY", "MAIL_BLIND_KEY", "BETTER_AUTH_URL", "SUPABASE_S3_ACCESS_KEY_ID", "SUPABASE_S3_SECRET_ACCESS_KEY"]) {
    assert.ok(missing.includes(name), name);
  }
  assert.ok(!missing.includes("CRON_SECRET"), "the RU-only settings are not asked of the US copy");
});

test("a ready US environment has nothing missing, and no value ever appears in the output", () => {
  const findings = checkEnv(US_READY, { region: "us" });
  assert.deepEqual(missingNames(findings), []);
  const printed = report(findings).lines.join("\n");
  for (const value of Object.values(US_READY)) if (value.length > 8) assert.ok(!printed.includes(value), "a value was printed");
});

test("shape checks: a short secret, a non-hex key, and a blind key that differs from the blob key", () => {
  const findings = checkEnv({ ...US_READY, BETTER_AUTH_SECRET: "short", MAIL_BLOB_KEY: "not-hex" }, { region: "us" });
  const l = levels(findings);
  assert.equal(l["BETTER_AUTH_SECRET (set, but shorter than 32 characters)"], "missing");
  assert.equal(l["MAIL_BLOB_KEY (set, but not 32 bytes of hex (64 characters))"], "missing");
  const differ = levels(checkEnv({ ...US_READY, MAIL_BLIND_KEY: "cd".repeat(32) }, { region: "us" }));
  assert.equal(differ["MAIL_BLIND_KEY differs from MAIL_BLOB_KEY"], "warn");
});

test("the Russia copy needs its database, storage and cron secret, and warns until the legal review", () => {
  const findings = checkEnv({ BETTER_AUTH_SECRET: "s".repeat(40), MAIL_BLOB_KEY: KEY, MAIL_BLIND_KEY: KEY }, { region: "ru" });
  const missing = missingNames(findings);
  for (const name of ["DATABASE_URL", "MAIL_S3_ACCESS_KEY_ID", "MAIL_S3_SECRET_ACCESS_KEY", "CRON_SECRET"]) assert.ok(missing.includes(name), name);
  assert.equal(levels(findings)["MAIL_LEGAL_RU_REVIEWED is not yes"], "warn");
  assert.ok(!missing.includes("SUPABASE_S3_ACCESS_KEY_ID"));
});

test("outbound and billing settings are all-or-nothing; MAIL_CSP and the grok switch are checked", () => {
  const smtp = missingNames(checkEnv({ ...US_READY, MAIL_SMTP_HOST: "smtp.example.com" }, { region: "us" }));
  for (const name of ["MAIL_SMTP_PORT", "MAIL_SMTP_USER", "MAIL_SMTP_PASSWORD", "MAIL_DKIM_SELECTOR", "MAIL_DKIM_PRIVATE_KEY or MAIL_DKIM_KEY_PATH"]) assert.ok(smtp.includes(name), name);
  assert.equal(levels(checkEnv(US_READY, { region: "us" }))["MAIL_SMTP_HOST is not set"], "warn");
  assert.ok(missingNames(checkEnv({ ...US_READY, STRIPE_SECRET_KEY: "sk_live_x" }, { region: "us" })).includes("STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET together"));
  assert.ok(missingNames(checkEnv({ ...US_READY, MAIL_CSP: "loose" }, { region: "us" })).includes("MAIL_CSP (set to an unknown mode)"));
  assert.equal(levels(checkEnv({ ...US_READY, VITE_GROK_EXTENSIONS: "1" }, { region: "us" }))["VITE_GROK_EXTENSIONS=1"], "warn");
});

test("the Hyperdrive placeholder is reported unless HYPERDRIVE_ID is given", () => {
  const files = { "workers/email/wrangler.jsonc": '{ "id": "REPLACE_WITH_HYPERDRIVE_ID" }', "workers/api/wrangler.jsonc": '{ "id": "0123abcd" }' };
  const l = levels(checkRepo((path) => files[path], { region: "us" }));
  assert.equal(l["Hyperdrive id for workers/email/wrangler.jsonc"], "missing");
  assert.equal(l["Hyperdrive id for workers/api/wrangler.jsonc"], "ok");
  // The deploy workflow's HYPERDRIVE_ID fills the placeholder (scripts/deploy-guard.mjs), so that is enough.
  const given = checkRepo((path) => files[path], { region: "us" }, { HYPERDRIVE_ID: "0123456789abcdef0123456789abcdef" });
  assert.deepEqual(given.map((f) => f.level), ["ok"]);
});

/** A resolver over a fixed zone: { "name": { TXT: [...], MX: [...], A: [...] } }. */
function fakeResolver(zone) {
  const get = (name, type) => {
    const v = zone[name]?.[type];
    if (!v) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    return v;
  };
  return {
    resolveTxt: async (name) => get(name, "TXT").map((r) => (Array.isArray(r) ? r : [r])),
    resolveMx: async (name) => get(name, "MX"),
    resolveNs: async (name) => get(name, "NS"),
    resolve: async (name, type) => get(name, type),
  };
}

test("DNS: a complete US zone passes, with the DKIM key compared against the signing key", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const p = dkimPublicKey(pem);
  const zone = {
    "mail.cumuluscloud.app": { CNAME: ["cumulus-mail-api.example.workers.dev"] },
    "cumuluscloud.app": { NS: ["ns1.example"], MX: [{ exchange: "route1.mx.cloudflare.net", priority: 10 }], TXT: ["v=spf1 include:relay.example ~all", "google-site-verification=x"] },
    "cm2026._domainkey.cumuluscloud.app": { TXT: [[`v=DKIM1; k=rsa; p=${p.slice(0, 200)}`, p.slice(200)]] },
    "_dmarc.cumuluscloud.app": { TXT: ["v=DMARC1; p=none"] },
    "_mta-sts.cumuluscloud.app": { TXT: ["v=STSv1; id=2026111601"] },
    "_smtp._tls.cumuluscloud.app": { TXT: ["v=TLSRPTv1; rua=mailto:r@example.com"] },
  };
  const findings = await checkDns(fakeResolver(zone), { region: "us", selector: "cm2026", privatePem: pem });
  assert.deepEqual(findings.filter((f) => f.level !== "ok"), []);
  assert.equal(levels(findings)["DKIM cm2026._domainkey.cumuluscloud.app matches the signing key"], "ok");
});

test("DNS: an empty zone lists exactly what to publish; two SPF records and a stale DKIM key are caught", async () => {
  const empty = await checkDns(fakeResolver({ "cumuluscloud.app": { NS: ["ns1.example"] } }), { region: "us", selector: "cm2026" });
  const missing = missingNames(empty);
  for (const what of ["mail.cumuluscloud.app does not resolve", "MX for cumuluscloud.app", "SPF (TXT v=spf1 on cumuluscloud.app)", "DKIM (TXT cm2026._domainkey.cumuluscloud.app)", "DMARC (TXT _dmarc.cumuluscloud.app)"]) {
    assert.ok(missing.includes(what), what);
  }
  assert.equal(levels(empty)["MTA-STS (TXT _mta-sts.cumuluscloud.app)"], "warn", "MTA-STS comes later, so it only warns");

  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const other = dkimPublicKey(generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }));
  const zone = {
    "cumuluscloud.app": { NS: ["ns1.example"], TXT: ["v=spf1 include:a ~all", "v=spf1 include:b ~all"] },
    "cm2026._domainkey.cumuluscloud.app": { TXT: [`v=DKIM1; p=${other}`] },
  };
  const bad = missingNames(await checkDns(fakeResolver(zone), { region: "us", selector: "cm2026", privatePem: privateKey.export({ type: "pkcs8", format: "pem" }) }));
  assert.ok(bad.includes("one SPF record on cumuluscloud.app (found 2)"));
  assert.ok(bad.includes("DKIM cm2026._domainkey.cumuluscloud.app does not match the signing key"));
});

test("DNS: the Russia copy checks its own host", async () => {
  const findings = await checkDns(fakeResolver({ "cumuluscloud.app": { NS: ["ns1.example"] }, "ru.mail.cumuluscloud.app": { A: ["203.0.113.7"] } }), { region: "ru", selector: "cmru2026" });
  assert.equal(levels(findings)["ru.mail.cumuluscloud.app resolves"], "ok");
});

test("DNS that cannot be read at all is one finding, not a list of records that look missing", async () => {
  const findings = await checkDns(fakeResolver({}), { region: "us", selector: "cm2026" });
  assert.deepEqual(missingNames(findings), ["DNS for cumuluscloud.app could not be read from this machine"]);
});

test("the report numbers what is missing and fails only on missing", () => {
  const { lines, failed } = report([{ level: "ok", what: "A" }, { level: "warn", what: "B", fix: "b", see: "x" }, { level: "missing", what: "C", fix: "do c", see: "y" }]);
  assert.equal(failed, true);
  assert.ok(lines.includes("  1. C: do c (y)"));
  assert.equal(report([{ level: "warn", what: "B", fix: "b", see: "x" }]).failed, false);
});

test("maintenance mode left on is a warning", () => {
  const findings = checkEnv({ ...US_READY, MAIL_MAINTENANCE: "1" }, { region: "us" });
  assert.equal(levels(findings)["MAIL_MAINTENANCE is on"], "warn");
  assert.equal(levels(checkEnv(US_READY, { region: "us" }))["MAIL_MAINTENANCE is on"], undefined);
});
