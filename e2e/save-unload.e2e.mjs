// A change is never silently lost to a reload: while its save is in flight the page says so
// (<html data-saving="1">) and leaving asks first (beforeunload); once saved, leaving is free again.
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
    if (!existsSync(fallback)) throw error;
    browser = await chromium.launch({ executablePath: fallback });
  }
});
after(async () => {
  await browser?.close();
});

const leavingIsBlocked = (page) =>
  page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });

test("while a save is in flight, leaving the page asks first; once it lands, it does not", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  try {
    await page.goto(URL_BASE, { waitUntil: "networkidle" });
    await page.locator("[data-row-id]").first().waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => document.documentElement.dataset.saving !== "1");
    assert.equal(await leavingIsBlocked(page), false, "an idle page can be left freely");

    // Hold the next save (a POST server-function call) for two seconds.
    let release;
    const held = new Promise((resolve) => (release = resolve));
    await page.route("**/_serverFn/**", async (route) => {
      if (route.request().method() === "POST") await held;
      await route.continue();
    });
    await page.locator("[data-row-id]").first().click();
    await page.locator('button[aria-label="Trash"]').first().click();
    await page.waitForFunction(() => document.documentElement.dataset.saving === "1", null, { timeout: 10_000 });
    assert.equal(await leavingIsBlocked(page), true, "leaving mid-save is refused (the browser asks)");

    release();
    await page.waitForFunction(() => document.documentElement.dataset.saving === "0", null, { timeout: 15_000 });
    assert.equal(await leavingIsBlocked(page), false, "after the save, leaving is free again");
  } finally {
    await context.close();
  }
});
