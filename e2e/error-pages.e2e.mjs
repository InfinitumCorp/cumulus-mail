// The 404 page: plain words and a way back, in English and Russian, with no internals and no errors.
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

for (const [locale, heading, back] of [
  ["en-US", "Page not found", "Go to your inbox"],
  ["ru-RU", "Страница не найдена", "Перейти во «Входящие»"],
]) {
  test(`${locale}: an unknown address shows the not-found page with a way back`, async () => {
    const context = await browser.newContext({ locale, viewport: { width: 390, height: 800 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(new URL("/no/such/page", URL_BASE).toString(), { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: heading }).waitFor({ timeout: 20_000 });
    const link = page.getByRole("link", { name: back });
    assert.equal(await link.getAttribute("href"), "/");
    assert.equal(await page.getByText(/Error|stack|undefined/).count(), 0, "no internals on the page");
    assert.deepEqual(errors, []);
    await context.close();
  });
}
