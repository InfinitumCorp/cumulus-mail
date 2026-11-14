// The floating language menu does not cover open dialogs (it covered the account dialog's text on phones).
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

test("language menu: hidden while a modal dialog is open, back when it closes", async () => {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto(URL_BASE, { waitUntil: "networkidle" });
  await page.locator("[data-row-id]").first().waitFor({ timeout: 30_000 });
  const menu = page.locator(".lang-float");
  await menu.waitFor({ state: "attached", timeout: 15_000 });
  assert.equal(await menu.isVisible(), true, "visible on the mail list");

  await page.getByRole("button", { name: "Compose", exact: true }).click();
  const compose = page.getByRole("dialog", { name: "Compose" });
  await compose.waitFor();
  assert.equal(await menu.isVisible(), false, "hidden while compose is open");
  await compose.getByRole("button", { name: "Close composer" }).click();
  await compose.waitFor({ state: "detached" });
  assert.equal(await menu.isVisible(), true, "back after it closes");
  await context.close();
});
