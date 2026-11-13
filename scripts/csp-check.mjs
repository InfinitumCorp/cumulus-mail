#!/usr/bin/env node
/**
 * `npm run csp:check`: the Content-Security-Policy (src/lib/csp.ts) against the production build, in a
 * real browser. Every `securitypolicyviolation` event on any page fails the run.
 *
 *   VITE_AUTH_ENABLED=false npm run build:node && npm run csp:check
 *
 * The e2e suite runs on the development server, which has no CSP (Vite injects its own inline
 * scripts), so this is where the policy is exercised: the mail list, a message, compose, the account
 * dialog, calendar and contacts, with the policy *enforced*.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { join } from "node:path";
import { chromium } from "playwright";
import { projectRoot } from "./nitro-preset.mjs";

const freePort = () =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

async function waitFor(url, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`server did not answer at ${url}`);
}

async function launch() {
  try {
    return await chromium.launch();
  } catch (error) {
    if (!existsSync("/opt/pw-browsers/chromium")) throw error;
    return chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  }
}

/** Each step opens a screen; `ready` is what must be visible before violations are read. */
const STEPS = [
  { name: "mail list", path: "/", ready: (page) => page.locator("[data-row-id]").first() },
  {
    name: "a message",
    path: "/",
    act: async (page) => page.locator("[data-row-id]").first().click(),
    ready: (page) => page.getByRole("button", { name: "Reply", exact: true }).first(),
  },
  {
    name: "compose",
    path: "/",
    act: async (page) => page.getByRole("button", { name: "Compose" }).first().click(),
    ready: (page) => page.getByRole("dialog", { name: "Compose" }),
  },
  {
    name: "calendar",
    path: "/",
    act: async (page) => page.getByRole("button", { name: "Calendar" }).first().click(),
    ready: (page) => page.getByRole("heading", { name: "Calendar" }).first(),
  },
  {
    name: "contacts",
    path: "/",
    act: async (page) => page.getByRole("button", { name: "Contacts" }).first().click(),
    ready: (page) => page.locator("p", { hasText: /^Contacts$/ }).first(),
  },
  { name: "a missing share link", path: "/p/00000000000000000000000000000000", ready: (page) => page.locator("body") },
];

export async function checkCsp(base) {
  const browser = await launch();
  const results = [];
  try {
    for (const step of STEPS) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
      const page = await context.newPage();
      await page.addInitScript(() => {
        window.__cspViolations = [];
        document.addEventListener("securitypolicyviolation", (e) => {
          window.__cspViolations.push(`${e.effectiveDirective} blocked ${e.blockedURI || "inline"} (${e.sourceFile || "?"}:${e.lineNumber || "?"})`);
        });
      });
      const response = await page.goto(base + step.path, { waitUntil: "networkidle" });
      const header = response?.headers()["content-security-policy"] ?? "";
      if (step.act) {
        await page.locator("[data-row-id]").first().waitFor({ timeout: 30_000 });
        await step.act(page);
      }
      let reached = true;
      try {
        await step.ready(page).waitFor({ timeout: 15_000 });
      } catch {
        reached = false;
      }
      await page.waitForTimeout(500);
      const violations = await page.evaluate(() => window.__cspViolations);
      results.push({ name: step.name, enforced: header.includes("script-src"), reached, violations });
      await context.close();
    }
  } finally {
    await browser.close();
  }
  return results;
}

async function main() {
  const root = projectRoot();
  const server = join(root, ".output/server/index.mjs");
  if (!existsSync(server)) {
    console.error("[csp] no production build: run `VITE_AUTH_ENABLED=false npm run build:node` first");
    process.exit(1);
  }
  const port = await freePort();
  const child = spawn(process.execPath, [server], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", MAIL_CSP: "enforce", MAIL_BLOB_KEY: randomBytes(32).toString("hex"), DATABASE_URL: "" },
    stdio: "ignore",
  });
  let failed = false;
  try {
    const base = `http://127.0.0.1:${port}`;
    await waitFor(`${base}/api/health`, 60_000);
    for (const r of await checkCsp(base)) {
      const bad = !r.enforced || !r.reached || r.violations.length > 0;
      failed ||= bad;
      const why = !r.enforced ? "no enforced CSP header" : !r.reached ? "screen did not open" : `${r.violations.length} violation(s)`;
      console.log(`[csp] ${bad ? "FAIL" : "ok  "} ${r.name}: ${why}`);
      for (const v of r.violations.slice(0, 5)) console.log(`[csp]        ${v}`);
    }
  } finally {
    child.kill();
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url.endsWith("csp-check.mjs")) await main();
