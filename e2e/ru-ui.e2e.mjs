// Russian interface: the text that used to stay English (found by loading the app in ru-RU and listing
// visible Latin text outside mail content): dates in the list and reader, plan usage labels, the sign-in
// note, and the calendar feed explanation.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { existsSync } from "node:fs";
import { chromium } from "playwright";

const URL_BASE = process.env.E2E_URL;
if (!URL_BASE) throw new Error("E2E_URL is not set. Run `npm run test:e2e`.");
const RU_MONTH = "(янв\\.|февр\\.|мар\\.|апр\\.|мая|июн\\.|июл\\.|авг\\.|сент\\.|окт\\.|нояб\\.|дек\\.)";

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

test("ru: list and reader dates, plan usage, the sign-in note and the calendar feed text are Russian", async () => {
  const context = await browser.newContext({ locale: "ru-RU", viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(URL_BASE, { waitUntil: "networkidle" });
  await page.locator("[data-row-id]").first().waitFor({ timeout: 30_000 });
  // The translator starts after hydration; wait for it.
  await page.getByLabel("Поиск в почте").first().waitFor({ timeout: 15_000 });

  await page.locator("[data-row-id]").first().locator("span.font-mono", { hasText: new RegExp(`^\\d{2} ${RU_MONTH}$`) }).waitFor({ timeout: 10_000 });

  await page.locator("[data-row-id]").first().click();
  await page.getByText(new RegExp(`^(пн|вт|ср|чт|пт|сб|вс), \\d{2} ${RU_MONTH}, \\d{2}:\\d{2} UTC$`)).first().waitFor({ timeout: 10_000 });

  await page.locator("aside button.w-full.border-t").click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await dialog.getByText("Коды двухфакторной аутентификации", { exact: false }).waitFor({ timeout: 10_000 });
  const text = await dialog.innerText();
  for (const english of ["Custom domains", "Two-factor codes", "IMAP and SMTP stay on a local bridge", " of "]) {
    assert.equal(text.includes(english), false, `still English in the account dialog: "${english}"`);
  }
  assert.match(text, /Свои домены/);
  await page.keyboard.press("Escape");

  // Sent mail's row title: "To" is interface text, so it is Russian; the name stays as written.
  await page.locator("aside").getByRole("button", { name: /^Отправленные/ }).first().click();
  await page.locator("[data-row-id]").first().locator("span.truncate", { hasText: /^Кому / }).first().waitFor({ timeout: 10_000 });
  // A system label is shown by its folder's (translated) name.
  await page.locator("aside").getByRole("button", { name: /^Карантин/ }).first().click();
  const quarantined = page.locator("[data-row-id]").first();
  if (await quarantined.count()) {
    await quarantined.click();
    await page.locator("p.uppercase", { hasText: "Карантин" }).first().waitFor({ timeout: 10_000 });
  }

  await page.getByRole("button", { name: "Календарь" }).or(page.getByRole("link", { name: "Календарь" })).first().click();
  await page.getByText("Личный адрес, на который можно подписаться", { exact: false }).waitFor({ timeout: 10_000 });
  assert.deepEqual(errors, []);
  await context.close();
});
