// Calendar subscription feed in a real browser: make the address, fetch it as a calendar app would,
// rotate it, and check the old one stops working.
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

test("create, subscribe, rotate, turn off", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(URL_BASE, { waitUntil: "networkidle" });
  await page.locator("[data-row-id]").first().waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Calendar" }).first().click();
  await page.getByRole("heading", { name: "Subscribe from another calendar" }).waitFor();

  await page.getByRole("button", { name: "Create address" }).click();
  const field = page.getByLabel("Calendar address (shown once)");
  await field.waitFor({ timeout: 10_000 });
  const first = await field.inputValue();
  assert.match(first, /\/api\/calendar\/cal_[A-Za-z0-9_-]{43}\.ics$/);

  // What a calendar app does: a plain GET, no cookie.
  const feed = await fetch(first);
  assert.equal(feed.status, 200);
  assert.match(feed.headers.get("content-type") ?? "", /^text\/calendar/);
  assert.match(feed.headers.get("cache-control") ?? "", /private/);
  assert.ok((await feed.text()).startsWith("BEGIN:VCALENDAR\r\n"));

  await page.getByRole("button", { name: "Make a new address" }).click();
  await page.waitForFunction((old) => document.querySelector("#calendar-feed-url")?.value !== old, first);
  const second = await field.inputValue();
  assert.notEqual(second, first);
  assert.equal((await fetch(first)).status, 404, "the old address stops working at once");
  assert.equal((await fetch(second)).status, 200);

  await page.getByRole("button", { name: "Turn off" }).click();
  await page.getByRole("status").filter({ hasText: "Turned off" }).waitFor({ timeout: 10_000 });
  assert.equal((await fetch(second)).status, 404);
  assert.deepEqual(errors, []);
  await page.close();
});
