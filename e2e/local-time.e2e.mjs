// Times in the viewer's own zone: the server renders UTC (it cannot know the zone), the first client
// render matches it, and right after hydration the list and the reader switch to local time, with the
// offset shown. No hydration errors on the way.
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

const local = (iso, timeZone, options) => new Intl.DateTimeFormat("en-GB", { timeZone, ...options }).format(new Date(iso));

test("a viewer in Moscow sees Moscow time (GMT+3) in the reader and the list, without hydration errors", async () => {
  const context = await browser.newContext({ timezoneId: "Europe/Moscow", viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /hydrat|did not match/i.test(message.text())) problems.push(message.text());
  });
  await page.goto(URL_BASE, { waitUntil: "networkidle" });
  const row = page.locator("[data-row-id]").first();
  await row.waitFor({ timeout: 30_000 });
  await row.click();

  const time = page.locator("article time, li time").first();
  await time.waitFor();
  const iso = await time.getAttribute("datetime");
  const expected = `${local(iso, "Europe/Moscow", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })} GMT+3`;
  await page.waitForFunction(([el, text]) => el.textContent?.trim() === text, [await time.elementHandle(), expected], { timeout: 10_000 });

  // The row shows the thread's latest message.
  const latest = await page.locator("li time").last().getAttribute("datetime");
  const day = local(latest, "Europe/Moscow", { day: "2-digit", month: "short" });
  assert.equal(await row.locator("span.font-mono", { hasText: day }).count(), 1, `list shows the Moscow day ${day}`);
  assert.deepEqual(problems, []);
  await context.close();
});

test("a viewer in UTC still sees UTC", async () => {
  const context = await browser.newContext({ timezoneId: "UTC" });
  const page = await context.newPage();
  await page.goto(URL_BASE, { waitUntil: "networkidle" });
  await page.locator("[data-row-id]").first().click();
  await page.locator("li time").first().filter({ hasText: / UTC$/ }).waitFor({ timeout: 10_000 });
  await context.close();
});
