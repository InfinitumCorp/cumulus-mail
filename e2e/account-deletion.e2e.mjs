// Account deletion in the dialog: confirm, see the date, cancel. The hard delete itself runs from the
// scheduler after 7 days and is covered by src/lib/mail/account-deletion.test.ts.
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

test("delete mailbox: a confirmation, a 7-day date, and cancel puts it back", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(URL_BASE, { waitUntil: "networkidle" });
  await page.locator("[data-row-id]").first().waitFor({ timeout: 30_000 });
  await page.locator("aside button.w-full.border-t").click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();

  await dialog.getByRole("button", { name: "Delete mailbox…" }).click();
  assert.match(await dialog.innerText(), /cannot be recovered after that/);
  // Changing one's mind at the confirmation deletes nothing.
  await dialog.getByRole("button", { name: "Keep my mailbox" }).click();
  await dialog.getByRole("button", { name: "Delete mailbox…" }).waitFor();

  await dialog.getByRole("button", { name: "Delete mailbox…" }).click();
  await dialog.getByRole("button", { name: "Delete in 7 days" }).click();
  const status = dialog.getByRole("status").filter({ hasText: "will be deleted on" });
  await status.waitFor({ timeout: 15_000 });
  const expected = new Date(Date.now() + 7 * 24 * 3_600_000).getUTCFullYear();
  assert.match(await status.innerText(), new RegExp(String(expected)));

  // The request survives a reload: it is on the server, not in the page.
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("[data-row-id]").first().waitFor({ timeout: 30_000 });
  await page.locator("aside button.w-full.border-t").click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel deletion" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete mailbox…" }).waitFor({ timeout: 15_000 });
  assert.deepEqual(errors, []);
  await page.close();
});
