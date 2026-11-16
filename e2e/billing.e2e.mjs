// Billing UI states in a real browser, with **no network**: every billing call is answered from a
// fixture inside the page, so nothing reaches Stripe and no key is needed. What is exercised is the
// account dialog's own logic — which controls appear for which subscription state, and what the
// notice says — not Stripe itself.
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

/**
 * Billing answers are built by taking the server's **real** response and rewriting the values in it.
 * Hand-writing the wire format would bake in today's encoding; patching the real envelope keeps these
 * tests about the UI, and they fail loudly if the shape ever changes (the assertions below are on
 * what the dialog renders, not on the bytes).
 */
const STATUS_KEYS = '"k":["enabled","subscribed","hasCustomer","planStatus","renewsAt"],"v":[';

const value = (v) => {
  if (v === null) return '{"t":2,"s":0}';
  if (typeof v === "boolean") return `{"t":2,"s":${v ? 2 : 3}}`;
  return `{"t":1,"s":${JSON.stringify(v)}}`;
};

function patchStatus(body, fixture) {
  const start = body.indexOf(STATUS_KEYS);
  if (start === -1) throw new Error(`the billing response no longer looks like ${STATUS_KEYS}: ${body.slice(0, 200)}`);
  const from = start + STATUS_KEYS.length;
  const end = body.indexOf("]", from);
  const values = [
    fixture.enabled ?? true,
    fixture.subscribed ?? false,
    fixture.hasCustomer ?? false,
    fixture.planStatus ?? "active",
    fixture.renewsAt ?? null,
  ].map(value);
  return `${body.slice(0, from)}${values.join(",")}${body.slice(end)}`;
}

/** Which server function a `/_serverFn/<base64>` request is for. */
function serverFnName(url) {
  if (!url.includes("/_serverFn/")) return null;
  try {
    const encoded = new URL(url).pathname.split("/").pop() ?? "";
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")).export ?? null;
  } catch {
    return null;
  }
}

/**
 * The account dialog with billing answered from `fixture`. Every billing call is fulfilled in the
 * browser, so no request reaches Stripe.
 */
async function openBilling(fixture) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/_serverFn/**", async (route) => {
    const name = serverFnName(route.request().url()) ?? "";
    if (name.startsWith("getBillingStatus")) {
      // Pass the real response through (it carries x-tss-serialized, which the client needs) and
      // change only the values inside it.
      const real = await route.fetch();
      return route.fulfill({ response: real, body: patchStatus(await real.text(), fixture) });
    }
    // Checkout and the portal are left alone: with no Stripe key configured the server refuses, which
    // is the error state the dialog has to handle. Nothing reaches Stripe either way.
    return route.continue();
  });
  // Nothing in these tests may leave the machine.
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) => route.abort());
  await page.goto(URL_BASE, { waitUntil: "networkidle" });
  await page.locator("[data-row-id]").first().waitFor({ timeout: 30_000 });
  await page.locator("aside button.w-full.border-t").click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  // Stop answering routes before the context goes: a billing call still in flight would otherwise
  // fail after the test ends ("Request context disposed") and fail the file.
  const close = async () => {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await context.close();
  };
  return { context, page, dialog, errors, close };
}

test("not subscribed: a plan picker and Upgrade, no Manage billing, no notice", async () => {
  const { close, dialog, errors } = await openBilling({ enabled: true, subscribed: false, hasCustomer: false });
  await dialog.getByRole("button", { name: "Upgrade" }).waitFor({ timeout: 10_000 });
  assert.equal(await dialog.getByRole("combobox", { name: "Plan to upgrade to" }).count(), 1);
  assert.equal(await dialog.getByRole("button", { name: "Manage billing" }).count(), 0);
  assert.equal(await dialog.getByText(/Payment failed|Renews/).count(), 0);
  assert.deepEqual(errors, []);
  await close();
});

test("subscribed and paid: Manage billing, no Upgrade, and the renewal date", async () => {
  const { close, dialog, errors } = await openBilling({
    enabled: true,
    subscribed: true,
    hasCustomer: true,
    planStatus: "active",
    renewsAt: "2027-03-04T00:00:00.000Z",
  });
  await dialog.getByRole("button", { name: "Manage billing" }).waitFor({ timeout: 10_000 });
  assert.equal(await dialog.getByRole("button", { name: "Upgrade" }).count(), 0);
  assert.match(await dialog.innerText(), /Renews Mar 4, 2027\./);
  assert.deepEqual(errors, []);
  await close();
});

test("payment failed: an urgent alert telling the person to update their card", async () => {
  const { close, dialog, errors } = await openBilling({
    enabled: true,
    subscribed: true,
    hasCustomer: true,
    planStatus: "past_due",
    renewsAt: "2027-03-04T00:00:00.000Z",
  });
  const alert = dialog.getByRole("alert");
  await alert.waitFor({ timeout: 10_000 });
  assert.match(await alert.innerText(), /Payment failed\. Update your card in Manage billing to keep your plan\./);
  assert.equal(await dialog.getByRole("button", { name: "Manage billing" }).count(), 1);
  assert.deepEqual(errors, []);
  await close();
});

test("when the server cannot start a checkout, the dialog says so instead of failing silently", async () => {
  const { close, page, dialog, errors } = await openBilling({ enabled: true, subscribed: false });
  await dialog.getByRole("button", { name: "Upgrade" }).click();
  const alert = dialog.getByRole("alert");
  await alert.waitFor({ timeout: 15_000 });
  assert.ok((await alert.innerText()).trim().length > 0);
  assert.equal(page.url().startsWith(URL_BASE), true, "the person is not sent anywhere on a failure");
  assert.deepEqual(errors, []);
  await close();
});

test("billing off: the account dialog shows no billing controls at all", async () => {
  const { close, dialog, errors } = await openBilling({ enabled: false });
  assert.ok((await dialog.innerText()).includes("Plan"));
  assert.equal(await dialog.getByRole("button", { name: "Upgrade" }).count(), 0);
  assert.equal(await dialog.getByRole("button", { name: "Manage billing" }).count(), 0);
  assert.deepEqual(errors, []);
  await close();
});
