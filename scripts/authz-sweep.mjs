#!/usr/bin/env node
/**
 * Authorization sweep against this checkout's production build (`npm run build:node`, either sign-in
 * setting: sign-in is decided at run time and this script turns it on).
 *
 *   npm run authz:sweep
 *
 * 1. Every server function in the build (read from the build itself, so a new one is covered the day it
 *    is added) is called without a session. Each must answer "Unauthorized", except the few that are public
 *    on purpose (PUBLIC_SERVER_FNS), which must refuse a forged token instead.
 * 2. Every route under src/routes/api must be listed in ROUTES below with the requests that prove it
 *    refuses a caller without credentials (or with forged ones). A new route that is not listed fails
 *    the sweep until someone decides how it is protected.
 *
 * The bridge and the cron tick are switched on here (MAIL_BRIDGE=on, a CRON_SECRET) so their own checks
 * are exercised, not just their "off" 404.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { toJSONAsync } from "seroval";

const root = join(import.meta.dirname, "..");
const output = join(root, ".output");
const server = join(output, "server", "index.mjs");

/** Server functions that need no session, and why. Keep in step with src/lib/security.test.ts. */
export const PUBLIC_SERVER_FNS = new Map([
  ["openShareLink", { data: { token: "forged.token" } }],
  ["fetchProtectedLink", { data: { token: "0".repeat(48) } }],
  ["burnProtectedLink", { data: { token: "0".repeat(48) } }],
  // A boolean (is the connector token configured); no data to protect.
  ["getConnectorReadiness", null],
]);

/**
 * Public functions that answer a forged token with success on purpose: burning an unknown link is a no-op
 * with the same answer as a real burn, so the answer says nothing about which links exist.
 */
const SAME_ANSWER_FOR_FORGED = new Set(["burnProtectedLink"]);

const refused = (status) => status >= 400 && status < 500;

/**
 * Every route file under src/routes/api, keyed by its path without `.ts`, with the requests that must be
 * refused. `public` routes are listed with the reason instead.
 */
export const ROUTES = {
  "account/export/$token": [{ method: "GET", path: "/api/account/export/forged.token", ok: refused }],
  "auth/$": [
    // Better Auth's own routes: with no cookie there is no session, and sign-out has nothing to end.
    { method: "GET", path: "/api/auth/get-session", ok: (status, body) => status === 200 && body.trim() === "null" },
    { method: "GET", path: "/api/auth/list-sessions", ok: refused },
  ],
  "billing/webhook": [
    { method: "POST", path: "/api/billing/webhook", body: "{}", ok: refused },
    { method: "POST", path: "/api/billing/webhook", body: "{}", headers: { "stripe-signature": "t=1,v1=forged" }, ok: (s) => s === 400 || s === 503 },
  ],
  "bridge/append": [
    { method: "POST", path: "/api/bridge/append", ok: (s) => s === 401 },
    { method: "POST", path: "/api/bridge/append", headers: { authorization: "Bearer forged" }, ok: (s) => s === 401 },
  ],
  "bridge/idle": [
    { method: "POST", path: "/api/bridge/idle", ok: (s) => s === 401 },
    { method: "POST", path: "/api/bridge/idle", headers: { authorization: "Bearer forged" }, ok: (s) => s === 401 },
  ],
  "bridge/move": [
    { method: "POST", path: "/api/bridge/move", ok: (s) => s === 401 },
    { method: "POST", path: "/api/bridge/move", headers: { authorization: "Bearer forged" }, ok: (s) => s === 401 },
  ],
  "bridge/sync": [
    { method: "POST", path: "/api/bridge/sync", ok: (s) => s === 401 },
    { method: "POST", path: "/api/bridge/sync", headers: { authorization: "Bearer forged" }, ok: (s) => s === 401 },
  ],
  "calendar/$token": [{ method: "GET", path: "/api/calendar/forged-token.ics", ok: (s) => s === 404 }],
  "cron/tick": [
    { method: "POST", path: "/api/cron/tick", ok: (s) => s === 401 },
    { method: "POST", path: "/api/cron/tick", headers: { authorization: "Bearer forged" }, ok: (s) => s === 401 },
  ],
  "csp-report": "public: browsers post violation reports without credentials (capped, rate-limited, #148)",
  health: "public: liveness for the platform and the smoke; counts only",
};

/** id, name and source file of every server function in the build. */
export function serverFunctions(dir = join(output, "server")) {
  const found = new Map();
  const walk = (path) => {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".mjs")) {
        const text = readFileSync(full, "utf8");
        for (const m of text.matchAll(/createServerRpc\(\{\s*id: "([a-f0-9]+)",\s*name: "(\w+)",\s*filename: "([^"]+)"/g)) {
          found.set(m[1], { id: m[1], name: m[2], file: m[3] });
        }
      }
    }
  };
  walk(dir);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The route files under src/routes/api, as ROUTES keys. */
export function apiRouteFiles(dir = join(root, "src", "routes", "api")) {
  const files = [];
  const walk = (path) => {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".ts") && !name.includes(".test.")) files.push(relative(dir, full).replace(/\.ts$/, ""));
    }
  };
  walk(dir);
  return files.sort();
}

/** The error message of a serialized server-function answer, or null when it carries a result. */
export function serverFnError(text) {
  const match = /"c":"\$TSR\/Error"|"message":\{"t":1,"s":"([^"]*)"/.exec(text);
  if (!match) return null;
  return /"message":\{"t":1,"s":"([^"]*)"/.exec(text)?.[1] ?? "error";
}

async function callServerFn(base, fn, payload) {
  const url = new URL(`/_serverFn/${fn.id}`, base);
  const body = JSON.stringify(await toJSONAsync(payload ?? { data: {} }));
  let response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
  if (response.status === 405) {
    url.searchParams.set("payload", body);
    response = await fetch(url);
  }
  return { status: response.status, text: await response.text() };
}

export async function sweep(base) {
  const problems = [];
  const lines = [];
  const fns = serverFunctions();
  if (fns.length < 10) problems.push(`only ${fns.length} server functions found in the build; is it a production build?`);
  for (const fn of fns) {
    const publicInput = PUBLIC_SERVER_FNS.get(fn.name);
    const { status, text } = await callServerFn(base, fn, publicInput ?? undefined);
    const error = serverFnError(text);
    if (PUBLIC_SERVER_FNS.has(fn.name)) {
      if (SAME_ANSWER_FOR_FORGED.has(fn.name)) {
        lines.push(`public  ${fn.name}: a forged token is a no-op with the same answer as a real one`);
        continue;
      }
      if (publicInput && !error && status < 400) problems.push(`${fn.name} accepted a forged token`);
      lines.push(`public  ${fn.name}: ${publicInput ? `forged input refused (${error ?? status})` : "no data"}`);
      continue;
    }
    if (error === "Unauthorized" || status === 401) lines.push(`refused ${fn.name}`);
    else problems.push(`${fn.name} (${fn.file}) without a session answered ${status}: ${error ?? text.slice(0, 120)}`);
  }

  const files = apiRouteFiles();
  for (const file of files) {
    const probes = ROUTES[file];
    if (!probes) {
      problems.push(`src/routes/api/${file}.ts is not in scripts/authz-sweep.mjs ROUTES: say how it refuses callers`);
      continue;
    }
    if (typeof probes === "string") {
      lines.push(`public  /api/${file}: ${probes}`);
      continue;
    }
    for (const probe of probes) {
      const response = await fetch(new URL(probe.path, base), {
        method: probe.method,
        headers: { "content-type": "application/json", ...(probe.headers ?? {}) },
        body: probe.method === "GET" ? undefined : (probe.body ?? "{}"),
        redirect: "manual",
      });
      const body = await response.text();
      const label = `${probe.method} ${probe.path}${probe.headers ? ` (${Object.keys(probe.headers).join(", ")})` : ""}`;
      if (probe.ok(response.status, body)) lines.push(`refused ${label}: ${response.status}`);
      else problems.push(`${label} answered ${response.status}: ${body.slice(0, 120)}`);
    }
  }
  for (const key of Object.keys(ROUTES)) if (!files.includes(key)) problems.push(`ROUTES lists ${key}, which no longer exists`);
  return { problems, lines, functions: fns.length, routes: files.length };
}

async function main() {
  if (!existsSync(server)) {
    console.error("[authz] no production build: run `npm run build:node` first");
    process.exit(2);
  }
  const port = 3700 + Math.floor(Math.random() * 200);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [server], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      VITE_AUTH_ENABLED: "true",
      BETTER_AUTH_URL: base,
      BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
      CRON_SECRET: randomBytes(24).toString("hex"),
      MAIL_BRIDGE: "on",
      MAIL_BRIDGE_WRITE: "on",
      DATABASE_URL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk) => (log += chunk));
  child.stderr.on("data", (chunk) => (log += chunk));
  try {
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
        // starting
      }
      if (Date.now() > deadline) throw new Error(`server did not start:\n${log.slice(-2000)}`);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    const result = await sweep(base);
    for (const line of result.lines) console.log(`[authz] ${line}`);
    if (result.problems.length) {
      for (const problem of result.problems) console.error(`[authz] FAIL ${problem}`);
      process.exitCode = 1;
    } else {
      console.log(`[authz] ok: ${result.functions} server functions and ${result.routes} API routes refuse callers without a session or with forged credentials`);
    }
  } finally {
    child.kill();
  }
}

if (process.argv[1] === import.meta.filename) await main();
