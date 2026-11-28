#!/usr/bin/env node
/**
 * `npm run smoke:worker`: the API worker's own build (`npm run build:workers`), run in workerd
 * (`wrangler dev`, the version the deploy workflow pins) against a real Postgres through Hyperdrive's
 * local connection string, with a fake S3 for blobs. Signed in through a real Better Auth session row.
 *
 *   npm run build:workers && WORKER_SMOKE_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/db npm run smoke:worker
 *
 * Unit tests, e2e and e2e:prod use PGLite or the Node build, so they cannot see what only workerd
 * refuses. Two such bugs reached open PRs before this check existed:
 * - a pg Pool kept across requests: a socket belongs to the request that opened it, so every second
 *   request hung until workerd cancelled it (#216);
 * - a random value made at module load in code that server rendering evaluates (#213).
 *
 * It also saves through `POST /api/mailbox/delta`: in order from one tab, then from five tabs at once.
 *
 * The database gets every migration (`scripts/migrate.mjs`) and one throwaway user and session, which
 * are deleted at the end. Wrangler needs a password in the connection string. Nothing is deployed.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import pg from "pg";
import { startFakeS3 } from "./dry-run/fake-s3.mjs";
import { projectRoot } from "./nitro-preset.mjs";

const WRANGLER = "wrangler@4.157.0"; // same pin as .github/workflows/deploy-cloudflare.yml
const ROUNDS = 10;

const root = projectRoot();
const serverDir = join(root, ".output/server");
const databaseUrl = process.env.WORKER_SMOKE_DATABASE_URL?.trim();

function fail(message) {
  console.error(`[smoke:worker] FAIL ${message}`);
  process.exitCode = 1;
}

if (!existsSync(join(serverDir, "wrangler.json"))) {
  console.error("[smoke:worker] no Workers build: run `npm run build:workers` first");
  process.exit(1);
}
if (!databaseUrl) {
  console.error("[smoke:worker] set WORKER_SMOKE_DATABASE_URL to a Postgres URL with a password");
  process.exit(1);
}

const freePort = () =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

async function migrate() {
  await new Promise((resolve, reject) => {
    const run = spawn(process.execPath, [join(root, "scripts/migrate.mjs")], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: ["ignore", "ignore", "inherit"],
    });
    run.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`db:migrate exited ${code}`))));
  });
}

const id = `smoke${randomBytes(6).toString("hex")}`;
const token = randomBytes(24).toString("hex");
const email = `${id}@cumuluscloud.app`;
const db = new pg.Client({ connectionString: databaseUrl });

const files = { config: join(serverDir, "wrangler.smoke.json"), vars: join(serverDir, ".dev.vars") };
let wrangler;
let s3;
let log = "";

try {
  await migrate();
  await db.connect();
  await db.query(`insert into "user"(id, name, email, "emailVerified") values ($1, $1, $2, true)`, [id, email]);
  await db.query(
    `insert into "session"(id, "expiresAt", token, "updatedAt", "userId") values ($1, now() + interval '1 hour', $2, now(), $3)`,
    [`${id}-s`, token, id],
  );

  s3 = await startFakeS3(0);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const config = JSON.parse(readFileSync(join(serverDir, "wrangler.json"), "utf8"));
  config.hyperdrive[0].localConnectionString = databaseUrl;
  delete config.placement;
  delete config.observability;
  Object.assign(config.vars, {
    BETTER_AUTH_URL: base,
    MAIL_APP_HOST: `127.0.0.1:${port}`,
    SUPABASE_S3_ENDPOINT: `http://127.0.0.1:${s3.port}`,
  });
  writeFileSync(files.config, JSON.stringify(config, null, 1));
  writeFileSync(
    files.vars,
    [
      `MAIL_BLOB_KEY=${randomBytes(32).toString("hex")}`,
      `BETTER_AUTH_SECRET=${randomBytes(32).toString("hex")}`,
      "SUPABASE_S3_ACCESS_KEY_ID=smoke",
      "SUPABASE_S3_SECRET_ACCESS_KEY=smoke",
      "",
    ].join("\n"),
  );
  await fetch(`http://127.0.0.1:${s3.port}/${config.vars.SUPABASE_S3_BUCKET}`, { method: "PUT" });

  wrangler = spawn(
    "npx",
    ["--yes", WRANGLER, "dev", "--config", "wrangler.smoke.json", "--port", String(port), "--ip", "127.0.0.1"],
    { cwd: serverDir, env: { ...process.env, CI: "1", NO_COLOR: "1" }, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  wrangler.stdout.on("data", (chunk) => (log += chunk));
  wrangler.stderr.on("data", (chunk) => (log += chunk));

  const until = Date.now() + 120_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/health`)).status < 500) break;
    } catch {
      // not up yet
    }
    if (Date.now() > until) throw new Error("wrangler dev did not start within 120 s");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // The health check is cached per host; a host per round makes each one query the database.
  let healthy = 0;
  for (let round = 0; round < ROUNDS; round += 1) {
    const response = await fetch(`${base}/api/health?deep=1`, { headers: { host: `round${round}.smoke.test` } });
    const body = await response.json().catch(() => ({}));
    if (body?.db?.ok === true) healthy += 1;
  }
  console.log(`[smoke:worker] health database check: ${healthy}/${ROUNDS}`);
  if (healthy !== ROUNDS) fail("the database check failed on some requests");

  let sessions = 0;
  for (let round = 0; round < ROUNDS; round += 1) {
    const response = await fetch(`${base}/api/auth/get-session`, { headers: { authorization: `Bearer ${token}` } });
    const body = await response.json().catch(() => null);
    if (response.status === 200 && body?.user?.id === id) sessions += 1;
  }
  console.log(`[smoke:worker] get-session: ${sessions}/${ROUNDS}`);
  if (sessions !== ROUNDS) fail("Better Auth failed to read the session on some requests");

  let pages = 0;
  for (let round = 0; round < 3; round += 1) {
    const response = await fetch(`${base}/`, { headers: { authorization: `Bearer ${token}` } });
    const html = await response.text();
    // The mailbox itself is filled in by the browser; a failed server render shows in the log (below).
    if (response.status === 200 && html.includes("</html>")) pages += 1;
  }
  console.log(`[smoke:worker] signed-in page render: ${pages}/3`);
  if (pages !== 3) fail("the signed-in page did not render");

  // Writes: the delta route runs the same save path as a full save (writeSnapshot in one transaction on
  // one connection of the request's pool, plus the per-tab save order). Same-site as a page would send it.
  const save = (tab, seq) =>
    fetch(`${base}/api/mailbox/delta`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "sec-fetch-site": "same-origin", origin: base },
      body: JSON.stringify({ base: {}, upsert: [], remove: [], fields: { signature: `smoke ${tab} ${seq}` }, tab, seq }),
    }).then((response) => response.status);
  const tab = `smoke-${randomBytes(8).toString("hex")}`;
  const sequential = [];
  for (let seq = 1; seq <= 5; seq += 1) sequential.push(await save(tab, seq));
  const applied = await db.query(`select seq from cumulus_mail.save_sequences where tenant_id = $1 and tab_id = $2`, [id, tab]).catch(() => ({ rows: [] }));
  const savedSeq = Number(applied.rows[0]?.seq ?? 0);
  console.log(`[smoke:worker] saves in order: ${sequential.filter((code) => code === 204).length}/5, newest applied ${savedSeq}`);
  if (sequential.some((code) => code !== 204) || savedSeq !== 5) fail(`saves in order answered ${sequential.join(",")}, newest applied ${savedSeq}`);
  const parallel = await Promise.all([1, 2, 3, 4, 5].map((n) => save(`smoke-${randomBytes(8).toString("hex")}`, n)));
  console.log(`[smoke:worker] concurrent saves: ${parallel.filter((code) => code === 204).length}/5`);
  if (parallel.some((code) => code !== 204)) fail(`concurrent saves answered ${parallel.join(",")}`);

  // Give the log a moment to flush, then look for what only workerd reports.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const refused = [
    "Disallowed operation called within global scope",
    "canceled this request because it detected that your Worker's code had hung",
    "Cannot perform I/O on behalf of a different request",
    "Error in renderToReadableStream",
  ].filter((text) => log.includes(text));
  for (const text of refused) fail(`workerd reported: ${text}`);
  if (process.exitCode !== 1) console.log("[smoke:worker] ok: the Workers build answers every request, signed in and out, and saves");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  if (wrangler?.pid) {
    try {
      process.kill(-wrangler.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  s3?.server.close();
  for (const file of Object.values(files)) rmSync(file, { force: true });
  try {
    await db.query(`delete from "user" where id = $1`, [id]);
    await db.query(`delete from cumulus_mail.mailboxes where tenant_id = $1`, [id]);
  } catch {
    // the insert may not have happened
  }
  await db.end().catch(() => undefined);
  if (process.exitCode === 1 && log) console.error(`[smoke:worker] wrangler output (last 3000 chars):\n${log.slice(-3000)}`);
}
