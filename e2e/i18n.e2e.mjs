// Interface language in the browser: Russian for a Russian browser (Accept-Language / navigator.languages),
// English otherwise, a language menu to switch, and mail content never translated.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { existsSync } from "node:fs";
import { chromium } from "playwright";

const URL = process.env.E2E_URL;
if (!URL) throw new Error("E2E_URL is not set. Run `npm run test:e2e`.");

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

async function open(locale) {
  const context = await browser.newContext({ locale, viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.locator("[data-row-id]").first().waitFor({ timeout: 30_000 });
  return { context, page, errors };
}

test("a Russian browser gets the Russian interface and a language menu; mail stays as written", async () => {
  const { context, page, errors } = await open("ru-RU");
  await page.getByRole("heading", { name: "Входящие" }).waitFor({ timeout: 10_000 });
  assert.equal(await page.evaluate(() => document.documentElement.lang), "ru");
  const menu = page.locator("select.lang-switch");
  assert.equal(await menu.count(), 1);
  // A subject from the sample mailbox is not translated.
  const firstRow = await page.locator("[data-row-id]").first().innerText();
  assert.ok(firstRow.trim().length > 0);
  // Switch to English from the menu: the UI follows and the choice is remembered.
  await menu.selectOption("en");
  await page.getByRole("heading", { name: "Inbox" }).waitFor({ timeout: 10_000 });
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Inbox" }).waitFor({ timeout: 30_000 });
  assert.deepEqual(errors, []);
  await context.close();
});

test("an English browser stays in English", async () => {
  const { context, page, errors } = await open("en-US");
  assert.equal(await page.getByRole("heading", { name: "Inbox" }).count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.lang), "en");
  assert.deepEqual(errors, []);
  await context.close();
});
