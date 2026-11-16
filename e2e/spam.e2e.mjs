// Report spam / Not spam in the reader: the message moves, the person is told what will happen next,
// and the page raises no error. The server side (lists, votes, inbound verdicts) is in spam.test.ts.
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

test("Report spam moves the message to Quarantine; Not spam brings it back", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(URL_BASE, { waitUntil: "networkidle" });
  const row = page.locator("[data-row-id]").first();
  await row.waitFor({ timeout: 30_000 });
  const id = await row.getAttribute("data-row-id");
  await row.click();
  await page.getByRole("button", { name: "Report spam" }).click();
  await page.getByText(/Reported as spam/).first().waitFor({ timeout: 10_000 });
  assert.equal(await page.locator(`[data-row-id="${id}"]`).count(), 0, "gone from the Inbox");

  await page.getByRole("link", { name: /Quarantine/ }).first().click().catch(async () => {
    await page.getByRole("button", { name: /Quarantine/ }).first().click();
  });
  const moved = page.locator(`[data-row-id="${id}"]`);
  await moved.waitFor({ timeout: 10_000 });
  await moved.click();
  await page.getByRole("button", { name: "Not spam" }).click();
  await page.getByText(/Marked as not spam/).first().waitFor({ timeout: 10_000 });
  assert.deepEqual(errors, []);
  await page.close();
});
