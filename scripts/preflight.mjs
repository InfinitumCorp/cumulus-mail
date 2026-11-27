#!/usr/bin/env node
/**
 * `npm run preflight -- --region us|ru [--domain cumuluscloud.app] [--selector cm2026] [--no-dns]`
 *
 * Before a deploy: checks the settings and DNS records docs/launch-checklist.md asks for, and prints
 * exactly what is missing and where it is explained. Run it with the same environment the deploy
 * gets (the secrets exported in the shell, or in the deploy job before the deploy step).
 *
 * It never prints a value. Secrets are only checked for presence and shape (length, hex), and
 * MAIL_BLIND_KEY is compared with MAIL_BLOB_KEY without showing either. DNS is read with the
 * system resolver; --no-dns skips it. Exit code: 1 if anything required is missing, else 0
 * (warnings alone do not fail it).
 */
import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { promises as dnsPromises } from "node:dns";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

/** A finding: `level` is "ok", "missing" (fails the run) or "warn". `fix` says what to do, `see` where. */
const ok = (what) => ({ level: "ok", what });
const missing = (what, fix, see) => ({ level: "missing", what, fix, see });
const warn = (what, fix, see) => ({ level: "warn", what, fix, see });

const set = (env, name) => typeof env[name] === "string" && env[name].trim() !== "";
const isHex32 = (value) => /^[0-9a-f]{64}$/i.test(String(value ?? "").trim());

/** Settings for one region. `env` is the deploy's environment; nothing in it is ever printed. */
export function checkEnv(env, { region }) {
  const out = [];
  const need = (name, test, fix, see) => {
    if (!set(env, name)) out.push(missing(name, fix, see));
    else if (test && !test(env[name])) out.push(missing(`${name} (set, but ${test.why})`, fix, see));
    else out.push(ok(name));
  };
  const minLength = (n) => Object.assign((v) => String(v).trim().length >= n, { why: `shorter than ${n} characters` });
  const hex32 = Object.assign(isHex32, { why: "not 32 bytes of hex (64 characters)" });

  // Both regions (checklist §1).
  need("BETTER_AUTH_SECRET", minLength(32), "32+ random bytes in the region's secret store; sign-in refuses to start without it", "launch-checklist §1");
  need("MAIL_BLOB_KEY", hex32, "openssl rand -hex 32, a new key per region (never a local one), then back it up", "launch-checklist §1");
  need("MAIL_BLIND_KEY", hex32, "set it to the same value as MAIL_BLOB_KEY at launch, and back it up", "launch-checklist §1");
  if (isHex32(env.MAIL_BLOB_KEY) && isHex32(env.MAIL_BLIND_KEY) && env.MAIL_BLOB_KEY.trim().toLowerCase() !== env.MAIL_BLIND_KEY.trim().toLowerCase()) {
    out.push(warn("MAIL_BLIND_KEY differs from MAIL_BLOB_KEY", "at launch they should be the same value; differing is only right after a deliberate rotation", "docs/ops/key-rotation.md"));
  }
  const csp = env.MAIL_CSP?.trim().toLowerCase();
  if (csp && !["enforce", "report-only", "off"].includes(csp)) out.push(missing(`MAIL_CSP (set to an unknown mode)`, "unset it (enforce), or enforce / report-only", "docs/deploy/csp.md"));
  else if (csp === "off") out.push(warn("MAIL_CSP=off", "no Content-Security-Policy is sent; unset it to enforce", "docs/deploy/csp.md"));
  else out.push(ok(`MAIL_CSP (${csp || "enforce"})`));
  if (["1", "on", "true"].includes(env.MAIL_MAINTENANCE?.trim().toLowerCase() ?? "")) {
    out.push(warn("MAIL_MAINTENANCE is on", "every page answers 503 with the maintenance page; unset it and redeploy to open the site", "docs/launch/friday.md"));
  }
  if (env.VITE_GROK_EXTENSIONS?.trim() === "1") out.push(warn("VITE_GROK_EXTENSIONS=1", "the owner decided no grok.com script ships; unset it or set 0", "docs/deploy/csp.md"));

  if (region === "us") {
    need("BETTER_AUTH_URL", (v) => /^https:\/\//.test(v), "the API worker's https origin", "launch-checklist §2");
    need("SUPABASE_S3_ACCESS_KEY_ID", null, "the inbound worker's storage key (Supabase S3)", "launch-checklist §2");
    need("SUPABASE_S3_SECRET_ACCESS_KEY", null, "the inbound worker's storage secret (Supabase S3)", "launch-checklist §2");
    if (env.MAIL_AUTH_DNS?.trim() !== "live") {
      out.push(warn("MAIL_AUTH_DNS is not live", "after the catch-all cutover and once SPF/DKIM/DMARC are published, set MAIL_AUTH_DNS=live on the inbound worker; until then spoofed mail is not quarantined", "launch-checklist §2"));
    } else out.push(ok("MAIL_AUTH_DNS=live"));
  }
  if (region === "ru") {
    need("DATABASE_URL", (v) => /^postgres(ql)?:\/\//.test(v), "the Russia copy's PostgreSQL URL (Lockbox)", "launch-checklist §3");
    need("MAIL_S3_ACCESS_KEY_ID", null, "Object Storage key (Lockbox)", "launch-checklist §3");
    need("MAIL_S3_SECRET_ACCESS_KEY", null, "Object Storage secret (Lockbox)", "launch-checklist §3");
    need("CRON_SECRET", minLength(32), "32+ random characters, and a timer trigger calling POST /api/cron/tick every minute", "launch-checklist §3");
    if (env.MAIL_LEGAL_RU_REVIEWED?.trim() !== "yes") {
      out.push(warn("MAIL_LEGAL_RU_REVIEWED is not yes", "/legal/privacy and /legal/terms show as drafts until a lawyer has checked them and this is set", "docs/legal-ru.md"));
    } else out.push(ok("MAIL_LEGAL_RU_REVIEWED=yes"));
  }

  // Outbound mail (§6): optional, but all-or-nothing once started.
  if (set(env, "MAIL_SMTP_HOST")) {
    for (const name of ["MAIL_SMTP_PORT", "MAIL_SMTP_USER", "MAIL_SMTP_PASSWORD", "MAIL_DKIM_SELECTOR"]) {
      need(name, null, "needed once MAIL_SMTP_HOST is set", "docs/deploy/outbound-smtp.md");
    }
    if (!set(env, "MAIL_DKIM_PRIVATE_KEY") && !set(env, "MAIL_DKIM_KEY_PATH")) {
      out.push(missing("MAIL_DKIM_PRIVATE_KEY or MAIL_DKIM_KEY_PATH", "outside mail must be DKIM-signed", "docs/deploy/outbound-smtp.md"));
    }
  } else {
    out.push(warn("MAIL_SMTP_HOST is not set", "outside mail stays held in the Outbox until an SMTP relay is configured", "launch-checklist §6"));
  }

  // Billing (§4): optional, but a pair.
  if (set(env, "STRIPE_SECRET_KEY") !== set(env, "STRIPE_WEBHOOK_SECRET")) {
    out.push(missing("STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET together", "set both, or neither", "launch-checklist §4"));
  } else if (set(env, "STRIPE_SECRET_KEY") && env.STRIPE_SECRET_KEY.trim().startsWith("sk_test_")) {
    out.push(warn("STRIPE_SECRET_KEY is a test-mode key", "switch to live keys after the test-mode run", "launch-checklist §4"));
  }
  return out;
}

/**
 * The Hyperdrive id: a 32-hex id already in the wrangler file, or HYPERDRIVE_ID in the environment.
 * The deploy workflow passes HYPERDRIVE_ID to scripts/deploy-guard.mjs, which fills
 * REPLACE_WITH_HYPERDRIVE_ID only when a file still has that placeholder. Either is enough.
 */
export function checkRepo(readText = (path) => readFileSync(join(ROOT, path), "utf8"), { region }, env = {}) {
  const out = [];
  if (region === "us" && /^[0-9a-f]{32}$/i.test(String(env.HYPERDRIVE_ID ?? "").trim())) {
    out.push(ok("Hyperdrive id (HYPERDRIVE_ID, passed to deploy-guard)"));
  } else if (region === "us") {
    for (const path of ["workers/email/wrangler.jsonc", "workers/api/wrangler.jsonc"]) {
      let text = "";
      try {
        text = readText(path);
      } catch {
        continue;
      }
      if (/"id"\s*:\s*"REPLACE_WITH_HYPERDRIVE_ID"/.test(text)) {
        out.push(missing(`Hyperdrive id for ${path}`, "set HYPERDRIVE_ID (32 hex characters; the deploy workflow's secret), or replace REPLACE_WITH_HYPERDRIVE_ID in the file", "launch-checklist §2"));
      } else out.push(ok(`Hyperdrive id for ${path}`));
    }
  }
  return out;
}

/** The DKIM public key (base64 SPKI) for a private key PEM, to compare with the published p=. */
export function dkimPublicKey(privatePem) {
  return createPublicKey(privatePem).export({ type: "spki", format: "der" }).toString("base64");
}

const txt = async (resolver, name) => {
  try {
    return (await resolver.resolveTxt(name)).map((chunks) => chunks.join(""));
  } catch {
    return [];
  }
};

/**
 * DNS for one region (docs/deploy/dns-records.md). `resolver` has resolveNs, resolveTxt, resolveMx and resolve
 * (node:dns/promises, or a fake in tests). `privatePem`, when given, is checked against the published key.
 */
export async function checkDns(resolver, { region, domain = "cumuluscloud.app", selector, privatePem }) {
  const out = [];
  const see = "docs/deploy/dns-records.md";
  // First, can DNS be read at all? Without this, a machine with no resolver would report every record missing.
  try {
    if (!(await resolver.resolveNs(domain)).length) throw new Error("no NS");
  } catch {
    return [missing(`DNS for ${domain} could not be read from this machine`, "run preflight where DNS works (or check that the domain is delegated); records were not checked", see)];
  }
  const appHost = region === "ru" ? `ru.mail.${domain}` : `mail.${domain}`;
  let resolves = false;
  for (const type of ["A", "AAAA", "CNAME"]) {
    try {
      if ((await resolver.resolve(appHost, type)).length) resolves = true;
    } catch {
      // try the next type
    }
  }
  out.push(resolves ? ok(`${appHost} resolves`) : missing(`${appHost} does not resolve`, region === "ru" ? "the API Gateway's certificate and DNS, kept off Cloudflare" : "the custom domain step in docs/deploy/cutover.md", region === "ru" ? "launch-checklist §3" : "docs/deploy/cutover.md"));

  let mx = [];
  try {
    mx = await resolver.resolveMx(domain);
  } catch {
    mx = [];
  }
  if (!mx.length) out.push(missing(`MX for ${domain}`, "turn on Cloudflare Email Routing for the zone (it creates the MX records)", see));
  else if (region === "us" && !mx.some((r) => /\.mx\.cloudflare\.net\.?$/i.test(r.exchange))) out.push(warn(`MX for ${domain} is not Cloudflare's`, "the US copy receives through Cloudflare Email Routing", see));
  else out.push(ok(`MX for ${domain}`));

  const spf = (await txt(resolver, domain)).filter((r) => /^v=spf1(\s|$)/i.test(r));
  if (spf.length === 0) out.push(missing(`SPF (TXT v=spf1 on ${domain})`, "v=spf1 include:<relay SPF include> ~all", see));
  else if (spf.length > 1) out.push(missing(`one SPF record on ${domain} (found ${spf.length})`, "merge them into a single v=spf1 record", see));
  else out.push(ok(`SPF on ${domain}`));

  if (!selector) {
    out.push(missing("DKIM selector to check", "pass --selector <name> or set MAIL_DKIM_SELECTOR", see));
  } else {
    const name = `${selector}._domainkey.${domain}`;
    const record = (await txt(resolver, name)).find((r) => /(^|;)\s*p=/.test(r));
    if (!record) out.push(missing(`DKIM (TXT ${name})`, `npm run dkim:record -- <key.pem> ${selector} ${domain}`, see));
    else {
      const published = /(?:^|;)\s*p=([^;]*)/.exec(record)?.[1].replace(/\s+/g, "") ?? "";
      if (privatePem) {
        let mine = "";
        try {
          mine = dkimPublicKey(privatePem);
        } catch {
          mine = "";
        }
        if (mine && mine === published) out.push(ok(`DKIM ${name} matches the signing key`));
        else out.push(missing(`DKIM ${name} does not match the signing key`, `republish it from npm run dkim:record -- <key.pem> ${selector} ${domain}`, see));
      } else out.push(ok(`DKIM ${name} published (not compared: no key given)`));
    }
  }

  const dmarc = (await txt(resolver, `_dmarc.${domain}`)).find((r) => /^v=DMARC1/i.test(r));
  out.push(dmarc ? ok(`DMARC on _dmarc.${domain}`) : missing(`DMARC (TXT _dmarc.${domain})`, "v=DMARC1; p=none; rua=mailto:<reports address>; adkim=s; aspf=r", see));
  const sts = (await txt(resolver, `_mta-sts.${domain}`)).find((r) => /^v=STSv1/i.test(r));
  out.push(sts ? ok(`MTA-STS on _mta-sts.${domain}`) : warn(`MTA-STS (TXT _mta-sts.${domain})`, "after inbound works: v=STSv1; id=<yyyymmdd01>, plus the policy file", see));
  const tlsrpt = (await txt(resolver, `_smtp._tls.${domain}`)).find((r) => /^v=TLSRPTv1/i.test(r));
  out.push(tlsrpt ? ok(`TLS-RPT on _smtp._tls.${domain}`) : warn(`TLS-RPT (TXT _smtp._tls.${domain})`, "v=TLSRPTv1; rua=mailto:<reports address>", see));
  return out;
}

/** Lines to print, and whether the run fails. */
export function report(findings) {
  const lines = [];
  const mark = { ok: "ok     ", warn: "WARN   ", missing: "MISSING" };
  for (const f of findings) lines.push(`${mark[f.level]} ${f.what}${f.level === "ok" ? "" : `\n          -> ${f.fix} (${f.see})`}`);
  const todo = findings.filter((f) => f.level === "missing");
  lines.push("");
  if (todo.length) {
    lines.push(`${todo.length} thing(s) missing before this deploy:`);
    todo.forEach((f, i) => lines.push(`  ${i + 1}. ${f.what}: ${f.fix} (${f.see})`));
  } else lines.push("Nothing required is missing.");
  const warnings = findings.filter((f) => f.level === "warn").length;
  if (warnings) lines.push(`${warnings} warning(s) above; they do not block a deploy.`);
  return { lines, failed: todo.length > 0 };
}

function parseArgs(argv) {
  const args = { region: "", domain: "cumuluscloud.app", selector: "", dns: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--region") args.region = argv[++i] ?? "";
    else if (a === "--domain") args.domain = argv[++i] ?? args.domain;
    else if (a === "--selector") args.selector = argv[++i] ?? "";
    else if (a === "--no-dns") args.dns = false;
  }
  return args;
}

/**
 * The identity providers the copy depends on, checked live (OpenID discovery):
 *   - the token issuer (CUMULUS_OIDC_ISSUER, else the code default): it must answer with exactly that
 *     issuer, as the app requires before trusting its keys (src/lib/auth/cumulus-issuer.ts);
 *   - the sign-in provider for the region (CID_ISSUER / CID_ISSUER_RU, else the defaults): it must answer.
 * `fetcher` is injectable for tests.
 */
export async function checkIssuers(fetcher, env, { region }) {
  const { DEFAULT_CUMULUS_ISSUER } = await import("../src/lib/auth/issuer-defaults.mjs");
  const strip = (v) => String(v).trim().replace(/\/+$/, "");
  const tokenIssuer = strip(env.CUMULUS_OIDC_ISSUER?.trim() || DEFAULT_CUMULUS_ISSUER);
  const signIn = strip(
    region === "ru"
      ? env.CID_ISSUER_RU?.trim() || "https://ru.id.cumuluscloud.app"
      : env.CID_ISSUER?.trim() || "https://id.cumuluscloud.app",
  );
  const out = [];
  const probe = async (label, base, expectIssuer) => {
    let response;
    try {
      response = await fetcher(`${base}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
    } catch {
      out.push(missing(`${label} ${base} could not be reached from this machine`, "run preflight where it can be reached, or check the issuer URL", "docs/launch/friday.md step 3"));
      return;
    }
    if (!response.ok) {
      out.push(missing(`${label} ${base} answers ${response.status} for discovery`, "point the setting at a live issuer (see #177 and the issuer decision in #86)", "docs/launch/friday.md step 3"));
      return;
    }
    let document;
    try {
      document = await response.json();
    } catch {
      out.push(missing(`${label} ${base}: discovery is not JSON`, "point the setting at an OpenID Connect issuer", "docs/launch/friday.md step 3"));
      return;
    }
    if (expectIssuer && document?.issuer !== base) {
      out.push(missing(`${label}: discovery names issuer ${document?.issuer}, not ${base}`, `set CUMULUS_OIDC_ISSUER to ${document?.issuer} (the app refuses keys from a mismatched document)`, "docs/launch/friday.md step 3"));
      return;
    }
    out.push(ok(`${label} ${base}`));
  };
  await probe("token issuer", tokenIssuer, true);
  await probe(region === "ru" ? "sign-in (Russia)" : "sign-in", signIn, false);
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.region !== "us" && args.region !== "ru") {
    console.error("Usage: npm run preflight -- --region us|ru [--domain cumuluscloud.app] [--selector <dkim selector>] [--no-dns]");
    process.exit(2);
  }
  const env = process.env;
  const findings = [...checkEnv(env, args), ...checkRepo(undefined, args, env)];
  if (args.dns) findings.push(...(await checkIssuers(fetch, env, args)));
  if (args.dns) {
    let privatePem = env.MAIL_DKIM_PRIVATE_KEY?.includes("PRIVATE KEY") ? env.MAIL_DKIM_PRIVATE_KEY : undefined;
    if (!privatePem && env.MAIL_DKIM_KEY_PATH) {
      try {
        privatePem = readFileSync(env.MAIL_DKIM_KEY_PATH, "utf8");
      } catch {
        privatePem = undefined;
      }
    }
    findings.push(...(await checkDns(dnsPromises, { region: args.region, domain: args.domain, selector: args.selector || env.MAIL_DKIM_SELECTOR, privatePem })));
  }
  console.log(`Preflight: ${args.region.toUpperCase()} copy, ${args.domain}${args.dns ? "" : " (DNS not checked)"}\n`);
  const { lines, failed } = report(findings);
  console.log(lines.join("\n"));
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
