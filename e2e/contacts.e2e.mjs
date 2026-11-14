// Contacts import and export in a real browser, with the sample files in src/lib/mail/fixtures/contacts.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const URL_BASE = process.env.E2E_URL;
if (!URL_BASE) throw new Error("E2E_URL is not set. Run `npm run test:e2e`.");
const fixture = (name) => fileURLToPath(new URL(`../src/lib/mail/fixtures/contacts/${name}`, import.meta.url));

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

test("import a Google CSV and an Android vCard, export vCard, re-import adds nothing", async () => {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(URL_BASE, { waitUntil: "networkidle" });
  await page.locator("[data-row-id]").first().waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Contacts" }).first().click();
  await page.getByRole("heading", { name: "People" }).waitFor();

  const input = page.locator('input[type="file"][accept*=".vcf"]');
  await input.setInputFiles(fixture("google-contacts.csv"));
  const status = page.getByRole("status").filter({ hasText: "Imported:" });
  await status.waitFor({ timeout: 10_000 });
  assert.match(await status.innerText(), /added/);
  await page.getByText("mira.chen@example.com").first().waitFor();

  await input.setInputFiles(fixture("android-2.1.vcf"));
  await page.getByText("Иван Иванов").first().waitFor({ timeout: 10_000 });

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export vCard" }).click()]);
  const vcf = readFileSync(await download.path(), "utf8");
  assert.ok(vcf.startsWith("BEGIN:VCARD\r\nVERSION:4.0"));
  assert.ok(vcf.includes("FN:Иван Иванов"));

  await input.setInputFiles(fixture("google-contacts.csv"));
  await page.getByRole("status").filter({ hasText: "0 added" }).waitFor({ timeout: 10_000 });
  assert.deepEqual(errors, []);
  await context.close();
});
