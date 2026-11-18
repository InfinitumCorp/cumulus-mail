#!/usr/bin/env node
/**
 * `npm run cutover:check -- --region us|ru [--domain cumuluscloud.app] [--selector cm2026]`
 *
 * The Friday rehearsal in one read-only command per region. Run it in the deploy shell, with the
 * region's secrets and DATABASE_URL exported, before anything is deployed:
 *
 *   1. preflight: secrets present and shaped right, repo settings, DNS (SPF, DKIM, DMARC, MX);
 *   2. migrations: which are pending, and that they are a clean tail (none skipped in the middle);
 *   3. the anon role is refused on public.session (Supabase's public key must not read sign-ins);
 *   4. the token issuer answers its discovery document and names itself.
 *
 * Nothing is written anywhere: the database is read inside a READ ONLY transaction that is rolled
 * back, and no value of any secret is printed. Exit code 1 if anything blocks the cutover, else 0.
 */
import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CUMULUS_ISSUER } from "../src/lib/auth/issuer-defaults.mjs";
import { pendingMigrations } from "./migration-plan.mjs";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const RUNBOOK = "docs/launch/friday.md";

const ok = (what) => ({ level: "ok", what });
const missing = (what, fix, see = RUNBOOK) => ({ level: "missing", what, fix, see });
const warn = (what, fix, see = RUNBOOK) => ({ level: "warn", what, fix, see });

/**
 * Pending migrations, and whether any is older than one already applied (applied out of order).
 * @param {string[]} files migration file names in the repo
 * @param {string[]} applied names in `_migrations`
 */
export function checkMigrations(files, applied) {
  const pending = pendingMigrations(files, applied);
  const out = [];
  const newestApplied = [...applied].sort().at(-1) ?? "";
  const skipped = pending.filter((item) => item.name < newestApplied);
  if (skipped.length) {
    out.push(
      missing(
        `Migrations skipped in the middle: ${skipped.map((item) => item.name).join(", ")} (newest applied is ${newestApplied})`,
        "find out why they were skipped before applying anything; db:migrate would apply them now, after newer ones",
      ),
    );
  }
  if (pending.length) {
    out.push(
      warn(
        `${pending.length} migration(s) to apply, in this order: ${pending.map((item) => item.name).join(", ")}`,
        "apply them with `npm run db:migrate` from the commit being deployed, before the deploy (step 4)",
      ),
    );
  } else out.push(ok(`Migrations up to date (${applied.length} applied)`));
  return out;
}

/**
 * `anon` must be refused on public.session. Runs `query` inside a READ ONLY transaction.
 * @param {(sql: string) => Promise<unknown>} query
 */
export async function checkAnon(query) {
  const roles = /** @type {{ rows: Array<{ n: string | number }> }} */ (
    await query("select count(*) as n from pg_roles where rolname = 'anon'")
  );
  if (Number(roles.rows[0]?.n ?? 0) === 0) return [ok("No anon role in this database (not Supabase): nothing to lock down")];
  const byHand = "check by hand in the Supabase SQL editor: `set role anon; select count(*) from public.session;` must fail";
  await query("savepoint anon_check");
  try {
    await query("set local role anon");
  } catch (error) {
    // 42501 here means this login may not become anon, not that anon is locked out.
    await query("rollback to savepoint anon_check").catch(() => undefined);
    const code = /** @type {{ code?: string }} */ (error)?.code;
    return [warn(`This database login cannot switch to the anon role (${code ?? "error"}), so anon was not checked`, byHand)];
  }
  try {
    await query("select count(*) from public.session");
  } catch (error) {
    const code = /** @type {{ code?: string }} */ (error)?.code;
    await query("rollback to savepoint anon_check").catch(() => undefined);
    if (code === "42501") return [ok("anon is refused on public.session (permission denied)")];
    if (code === "42P01") return [warn("public.session does not exist yet", "apply the auth migrations, then run this again")];
    return [warn(`Could not check anon on public.session (${code ?? "error"})`, byHand)];
  }
  await query("rollback to savepoint anon_check").catch(() => undefined);
  return [missing("anon can read public.session: the public key can read sign-in sessions", "apply 0020_auth_lockdown.sql (npm run db:migrate), then run this again")];
}

/**
 * The token issuer must answer its discovery document and name itself as the issuer.
 * @param {typeof fetch} fetcher
 * @param {Record<string, string | undefined>} env
 */
export async function checkIssuer(fetcher, env) {
  const issuer = (env.CUMULUS_OIDC_ISSUER?.trim() || DEFAULT_CUMULUS_ISSUER).replace(/\/+$/, "");
  const where = `${issuer}/.well-known/openid-configuration`;
  const fix = "set CUMULUS_OIDC_ISSUER to the issuer Cumulus://ID signs tokens with, or fix the default";
  let response;
  try {
    response = await fetcher(where, { signal: AbortSignal.timeout(10_000) });
  } catch {
    return [missing(`Token issuer does not answer: ${where}`, fix)];
  }
  if (!response.ok) return [missing(`Token issuer answers ${response.status}: ${where}`, fix)];
  let document;
  try {
    document = await response.json();
  } catch {
    return [missing(`Token issuer's discovery document is not JSON: ${where}`, fix)];
  }
  if (String(document?.issuer ?? "").replace(/\/+$/, "") !== issuer) {
    return [missing(`Token issuer names a different issuer (${document?.issuer ?? "none"}): ${where}`, fix)];
  }
  return [ok(`Token issuer answers and names itself: ${issuer}`)];
}

function parseArgs(argv) {
  const passthrough = [];
  let region = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--region") region = argv[++i] ?? "";
    else passthrough.push(argv[i]);
  }
  return { region, passthrough };
}

async function databaseFindings(databaseUrl) {
  if (!databaseUrl) return [missing("DATABASE_URL is not set", "export the region's database URL in this shell (it is only read)")];
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: databaseUrl });
  try {
    await client.connect();
  } catch (error) {
    return [missing(`Cannot connect to the database (${error?.code ?? "error"})`, "check DATABASE_URL and that this shell can reach the database")];
  }
  try {
    await client.query("begin read only");
    let applied = [];
    try {
      await client.query("savepoint list");
      applied = (await client.query("select name from _migrations")).rows.map((row) => row.name);
    } catch (error) {
      if (error?.code !== "42P01") throw error;
      await client.query("rollback to savepoint list");
    }
    const files = (await readdir(join(ROOT, "migrations"))).filter((name) => name.endsWith(".sql"));
    return [...checkMigrations(files, applied), ...(await checkAnon((sql) => client.query(sql)))];
  } finally {
    await client.query("rollback").catch(() => undefined);
    await client.end();
  }
}

async function main() {
  const { region, passthrough } = parseArgs(process.argv.slice(2));
  if (region !== "us" && region !== "ru") {
    console.error("Usage: npm run cutover:check -- --region us|ru [--domain cumuluscloud.app] [--selector <dkim selector>]");
    process.exit(2);
  }
  console.log(`== 1/4 preflight (${region.toUpperCase()}) ==`);
  const preflight = spawnSync(process.execPath, [join(ROOT, "scripts/preflight.mjs"), "--region", region, ...passthrough], { stdio: "inherit" });
  console.log("\n== 2-4/4 migrations, anon lockdown, token issuer ==");
  const findings = [...(await databaseFindings(process.env.DATABASE_URL)), ...(await checkIssuer(fetch, process.env))];
  const mark = { ok: "ok     ", warn: "WARN   ", missing: "MISSING" };
  for (const f of findings) console.log(`${mark[f.level]} ${f.what}${f.level === "ok" ? "" : `\n          -> ${f.fix} (${f.see})`}`);
  const blocking = findings.filter((f) => f.level === "missing").length + (preflight.status === 0 ? 0 : 1);
  console.log(
    blocking
      ? `\nNOT READY: ${blocking} blocking item(s)${preflight.status === 0 ? "" : " (preflight failed, see above)"}.`
      : `\nREADY for the ${region.toUpperCase()} cutover (warnings, if any, are listed above).`,
  );
  process.exit(blocking ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
