// Server functions refuse cross-site browser requests (src/start.ts, csrfMiddleware). Replays one of the
// app's own server-function calls with the headers a browser sends from another site, and from this one.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { existsSync } from "node:fs";
import { chromium } from "playwright";

const URL_BASE = process.env.E2E_URL;
if (!URL_BASE) throw new Error("E2E_URL is not set. Run `npm run test:e2e`.");

let browser;
before(async () => {
  const path = process.env.E2E_CHROMIUM_PATH;
  try {
    browser = await chromium.launch(path ? { executablePath: path } : {});
  } catch (error) {
    const fallback = "/opt/pw-browsers/chromium";
    if (path || !existsSync(fallback)) throw error;
    browser = await chromium.launch({ executablePath: fallback });
  }
});
after(async () => {
  await browser?.close();
});

test("csrf: a server function called from another site is refused (403); from this site it runs", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const calls = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.includes("/_serverFn/")) calls.push(request);
  });
  await page.goto(URL_BASE, { waitUntil: "networkidle" });
  await page.locator("[data-row-id]").first().waitFor({ timeout: 30_000 });
  // Star a message, so there is a state-changing call (a POST) to replay.
  await page.locator("[data-row-id]").first().click();
  await page.getByRole("button", { name: /^(Star|Remove star)$/ }).first().click();
  await page.waitForLoadState("networkidle");
  const call = calls.find((request) => request.method() === "POST") ?? calls[0];
  assert.ok(call, "the app made a server-function call");

  const replay = (site, origin) => {
    const headers = { ...call.headers(), "sec-fetch-site": site, "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" };
    delete headers["content-length"];
    if (origin) headers.origin = origin;
    return context.request.fetch(call.url(), { method: call.method(), headers, data: call.postDataBuffer() ?? undefined, maxRedirects: 0 });
  };
  const cross = await replay("cross-site", "https://attacker.example");
  assert.equal(cross.status(), 403, "cross-site");
  const sameSite = await replay("same-site", "https://other.cumuluscloud.app");
  assert.equal(sameSite.status(), 403, "same-site but another origin");
  const same = await replay("same-origin", new URL(URL_BASE).origin);
  assert.notEqual(same.status(), 403, "same-origin");
  assert.ok(same.status() < 500, `same-origin replay answered ${same.status()}`);

  // Put the star back.
  await page.getByRole("button", { name: /^(Star|Remove star)$/ }).first().click();
  await context.close();
});
