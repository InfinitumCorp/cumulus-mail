// A first user's whole first session, in one browser: finish setup, write to yourself, receive it,
// reply, find it with search, and delete it (it leaves the Inbox, and stays out after a reload). Each step checks what a person would see, and the page
// raises no error. (Sign-up itself happens at Cumulus ID, outside this app; local mode signs in as the
// development mailbox, which is where a new account lands after its first sign-in.)
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

const row = (page, subject) => page.locator("[data-row-id]").filter({ hasText: subject });

test("first session: setup, send to self, receive, reply, search, delete", async () => {
  const context = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(new URL("/?setup=1", URL_BASE).href, { waitUntil: "networkidle" });
  await page.locator("[data-row-id]").first().waitFor({ timeout: 30_000 });
  const me = (await page.locator("header p.font-mono").first().innerText()).trim();
  assert.match(me, /@/, "the header shows the mailbox address");

  // 1. Onboarding: the "Finish setting up" card opens the setup dialog; save a display name.
  await page.getByRole("button", { name: /Finish setting up|Set up/i }).first().click();
  const setup = page.getByRole("dialog");
  await setup.waitFor();
  const name = setup.getByLabel(/Display name|Name/i).first();
  await name.fill("First User");
  await setup.getByRole("button", { name: /^Save/ }).click();
  await setup.waitFor({ state: "detached" });

  // 2. Send to self.
  const subject = `First session ${Date.now()}`;
  await page.getByRole("button", { name: "Compose", exact: true }).last().click();
  const compose = page.getByRole("dialog", { name: "Compose" });
  await compose.getByLabel("To").fill(me);
  await compose.getByLabel("Subject").fill(subject);
  await compose.getByLabel("Message").fill("Hello from my first session.");
  await compose.getByRole("button", { name: "Send", exact: true }).click();
  await compose.waitFor({ state: "detached" });
  await page.getByText("Message sent.").waitFor();

  // 3. Receive: after the undo window the delivered copy joins the conversation (2 messages), and it
  //    is still there after a reload (stored on the server, not just in the page).
  await page.waitForFunction(
    (subject) =>
      [...document.querySelectorAll("[data-row-id]")].some((el) => el.innerText.includes(subject) && /\n2\n/.test(el.innerText)),
    subject,
    { timeout: 40_000 },
  );
  // Every change is saved before the reload (the app also asks before leaving mid-save, store.ts).
  await page.waitForFunction(() => document.documentElement.dataset.saving !== "1");
  await page.reload({ waitUntil: "networkidle" });
  await row(page, subject).first().waitFor({ timeout: 30_000 });

  // 4. Reply, from the reader (the reply opens inline, quoting the message).
  await row(page, subject).first().click();
  await page.getByRole("button", { name: "Reply", exact: true }).first().click();
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await message.waitFor();
  assert.match(await message.inputValue(), /On .*wrote|On .*First User/s, "the reply quotes the message");
  await message.press("Control+Home");
  await message.type("Replying to myself. ");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("Message sent.").first().waitFor();
  // The reply and, after the undo window, its delivered copy: 4 messages in the conversation.
  await page.waitForFunction(
    (subject) =>
      [...document.querySelectorAll("[data-row-id]")].some((el) => el.innerText.includes(subject) && /\n4\n/.test(el.innerText)),
    subject,
    { timeout: 40_000 },
  );

  // 5. Search finds it.
  const search = page.getByRole("searchbox", { name: "Search mail" });
  await search.fill(subject.split(" ").pop());
  await row(page, subject).first().waitFor({ timeout: 15_000 });
  assert.ok((await row(page, subject).count()) >= 1, "search finds the conversation");
  await search.fill("");

  // 6. Delete from the reader (its Trash button, not the sidebar's Trash folder): the conversation leaves
  //    the Inbox, is in Trash, and both are still true after a reload (saved on the server).
  await row(page, subject).first().click();
  await page.locator('button[aria-label="Trash"]').first().click();
  await page.getByText("Moved to Trash.").first().waitFor();
  await row(page, subject).first().waitFor({ state: "detached", timeout: 15_000 });
  // Every change is saved before the reload (the app also asks before leaving mid-save, store.ts).
  await page.waitForFunction(() => document.documentElement.dataset.saving !== "1");
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("[data-row-id]").first().waitFor({ timeout: 30_000 });
  assert.equal(await row(page, subject).count(), 0, "still gone from the Inbox after a reload");
  await page.locator("aside.nav-pane").getByRole("button", { name: /^Trash/ }).first().click();
  await row(page, subject).first().waitFor({ timeout: 15_000 });

  assert.deepEqual(errors, []);
  await context.close();
});
