#!/usr/bin/env node
/**
 * `npm run verify:live -- --region us|ru`: read-only checks of a live host after a deploy. It runs the host
 * smoke (scripts/host-smoke.mjs) and adds what a ship needs on top of it:
 *
 *   health    `/api/health?deep=1`: status ok, the region, database and storage up, schema current;
 *   page      the new app (not the old page worker), and the edge in front of it;
 *   sign-in   the authorize redirect to Cumulus ID with PKCE, callback on this host;
 *   security  an enforced CSP with a nonce and the report endpoint, no grok.com, nosniff, referrer and
 *             permissions policies, HSTS;
 *   api-auth  protected endpoints refuse requests without credentials;
 *   robots    `/robots.txt` keeps crawlers out of `/api/` and `/_serverFn/`; `/` is indexable on the production
 *             names and `noindex` anywhere else (a platform URL before cutover); a share page `/p/…` is
 *             `noindex` everywhere;
 *   commit    with `--commit <sha>`, the deployed build is that commit.
 *
 *   npm run verify:live -- --region us                      https://mail.cumuluscloud.app
 *   npm run verify:live -- --region ru                      https://ru.mail.cumuluscloud.app
 *   npm run verify:live -- --region us --url https://cumulus-mail-api.<account>.workers.dev   before cutover
 *   npm run verify:live -- --region us --commit 68722aa     also check the deployed commit
 *
 * Exits 1 when any check fails, 2 on a usage error. Read-only: it sends GET requests, plus the anonymous
 * sign-in start and protected-endpoint probes the host smoke already makes. It writes nothing and needs no secret. Run it against today's hosts before the ship to see
 * what "before" looks like: the old page worker fails health, page, sign-in and security, by design.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runHostSmoke } from "./host-smoke.mjs";

export const LIVE_HOSTS = { us: "https://mail.cumuluscloud.app", ru: "https://ru.mail.cumuluscloud.app" };
const PRODUCTION_NAMES = new Set(Object.values(LIVE_HOSTS).map((url) => new URL(url).hostname));
const SHARE_PROBE = `/p/${"0".repeat(32)}`;

function noindex(response) {
  return /\bnoindex\b/i.test(response.headers.get("x-robots-tag") ?? "");
}

/** robots.txt, and the X-Robots-Tag on `/` and on a share page, for this host. */
export async function checkRobots(base, fetcher) {
  const problems = [];
  const robots = await fetcher(new URL("/robots.txt", base), { redirect: "manual" });
  const text = robots.status === 200 ? await robots.text() : "";
  if (robots.status !== 200) problems.push(`/robots.txt is ${robots.status}`);
  else {
    for (const path of ["/api/", "/_serverFn/"]) {
      if (!new RegExp(`^Disallow:\\s*${path.replace(/[/]/g, "\\/")}\\s*$`, "mi").test(text)) problems.push(`robots.txt does not disallow ${path}`);
    }
  }
  const production = PRODUCTION_NAMES.has(new URL(base).hostname);
  const home = await fetcher(new URL("/", base), { redirect: "manual" });
  if (production && noindex(home)) problems.push("/ is noindex on a production name");
  if (!production && !noindex(home)) problems.push("/ is indexable on a non-production host (expected X-Robots-Tag: noindex)");
  const share = await fetcher(new URL(SHARE_PROBE, base), { redirect: "manual" });
  if (!noindex(share)) problems.push("a share page /p/… is not noindex");
  return {
    name: "robots",
    ok: problems.length === 0,
    detail: problems.length
      ? problems.join("; ")
      : `robots.txt keeps out /api/ and /_serverFn/; / is ${production ? "indexable (production name)" : "noindex (platform host)"}; /p/… is noindex`,
  };
}

/** The deployed commit from `/api/health`, against the one expected (a prefix of either is enough). */
export async function checkCommit(base, fetcher, expected) {
  const response = await fetcher(new URL("/api/health", base), { redirect: "manual" });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const deployed = typeof body?.commit === "string" ? body.commit : "";
  const want = expected.trim().toLowerCase();
  const ok = Boolean(deployed) && Boolean(want) && (deployed.startsWith(want) || want.startsWith(deployed));
  return {
    name: "commit",
    ok,
    detail: deployed ? (ok ? `deployed ${deployed}` : `deployed ${deployed}, expected ${expected}`) : `no commit in /api/health (HTTP ${response.status})`,
  };
}

export async function verifyLive({ region, url, commit, fetcher = fetch, log = console.log } = {}) {
  if (region !== "us" && region !== "ru") throw new Error("--region must be us or ru");
  const base = url ?? LIVE_HOSTS[region];
  const host = new URL(base).hostname;
  const smoke = await runHostSmoke(base, { fetcher, region, log: (line) => log(line.replace("[smoke ", "[verify ")) });
  const extra = [];
  for (const [name, run] of [
    ["robots", () => checkRobots(base, fetcher)],
    ...(commit ? [["commit", () => checkCommit(base, fetcher, commit)]] : []),
  ]) {
    try {
      extra.push(await run());
    } catch (error) {
      extra.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const r of extra) log(`[verify ${host}] ${r.ok ? "ok  " : "FAIL"} ${r.name}: ${r.detail}`);
  const results = [...smoke.results, ...extra];
  const failed = results.filter((r) => !r.ok);
  log(`[verify ${host}] ${failed.length ? `FAIL ${failed.length} of ${results.length} checks: ${failed.map((r) => r.name).join(", ")}` : `ok: all ${results.length} checks pass`}`);
  return { ok: failed.length === 0, results };
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // Node's fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 (Node 22.21+); behind a proxy, re-run with it.
  if ((process.env.HTTPS_PROXY || process.env.https_proxy) && process.env.NODE_USE_ENV_PROXY !== "1") {
    const rerun = spawnSync(process.execPath, ["--disable-warning=UNDICI-EHPA", ...process.argv.slice(1)], { stdio: "inherit", env: { ...process.env, NODE_USE_ENV_PROXY: "1" } });
    process.exit(rerun.status ?? 1);
  }
  const argv = process.argv.slice(2);
  try {
    const { ok } = await verifyLive({ region: arg(argv, "--region"), url: arg(argv, "--url") ?? arg(argv, "--host"), commit: arg(argv, "--commit") });
    process.exit(ok ? 0 : 1);
  } catch (error) {
    console.error(`[verify] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
