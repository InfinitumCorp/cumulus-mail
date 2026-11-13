// "Download my data" in a real browser against the local server: the two files download, they hold
// the mailbox, and a second download the same day is refused with a clear message.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
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

test("Download my data: mbox and JSON download once, then wait a day", async () => {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(URL_BASE, { waitUntil: "networkidle" });
  await page.locator("[data-row-id]").first().waitFor({ timeout: 30_000 });
  await page.locator("aside button.w-full.border-t").click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();

  const mboxButton = dialog.getByRole("button", { name: "Messages (mbox)" });
  const [mbox] = await Promise.all([page.waitForEvent("download", { timeout: 30_000 }), mboxButton.click()]);
  assert.match(mbox.suggestedFilename(), /^cumulus-mail-messages-\d{4}-\d{2}-\d{2}\.mbox$/);
  const mboxText = readFileSync(await mbox.path(), "utf8");
  assert.match(mboxText, /^From \S+ \w{3} \w{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/m, "an mbox separator line");
  assert.ok((mboxText.match(/^From \S+ \w{3} \w{3} /gm) ?? []).length >= 5, "the sample mailbox's messages");

  const [json] = await Promise.all([
    page.waitForEvent("download", { timeout: 30_000 }),
    dialog.getByRole("button", { name: "Contacts, calendar and settings (JSON)" }).click(),
  ]);
  const data = JSON.parse(readFileSync(await json.path(), "utf8"));
  assert.equal(data.format, "cumulus-mail/data-export");
  assert.ok(data.messages.count >= 5);

  // Same day again: no download, a message saying when it is available.
  await mboxButton.click();
  const status = dialog.getByRole("status");
  await status.waitFor({ timeout: 15_000 });
  assert.match(await status.innerText(), /Already downloaded today\. Available again/);
  assert.deepEqual(errors, []);
  await context.close();
});
