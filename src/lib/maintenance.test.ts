import assert from "node:assert/strict";
import { test } from "node:test";
import { maintenanceAllows, maintenanceHtml, maintenanceOn, maintenanceResponse, RETRY_AFTER_SECONDS } from "./maintenance.ts";

test("maintenance is off unless MAIL_MAINTENANCE is 1, on or true", () => {
  assert.equal(maintenanceOn({}), false);
  assert.equal(maintenanceOn({ MAIL_MAINTENANCE: "0" }), false);
  assert.equal(maintenanceOn({ MAIL_MAINTENANCE: "" }), false);
  for (const value of ["1", "on", "true", " ON "]) assert.equal(maintenanceOn({ MAIL_MAINTENANCE: value }), true, value);
});

test("health, CSP reports and the cron tick keep working; everything else is held", () => {
  for (const path of ["/api/health", "/api/health/", "/api/csp-report", "/api/cron/tick"]) assert.equal(maintenanceAllows(path), true, path);
  for (const path of ["/", "/p/abc", "/api/auth/sign-in/social", "/_serverFn/x", "/api/account/export/t", "/legal/privacy"]) {
    assert.equal(maintenanceAllows(path), false, path);
  }
});

test("a browser gets a 503 page in both languages, Russian first on the Russia copy, with no script", async () => {
  const request = new Request("https://mail.cumuluscloud.app/", { headers: { accept: "text/html,application/xhtml+xml" } });
  const response = maintenanceResponse(request, "us");
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), String(RETRY_AFTER_SECONDS));
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  const html = await response.text();
  assert.match(html, /<html lang="en">/);
  assert.match(html, /is being updated/);
  assert.match(html, /обновляется/);
  assert.doesNotMatch(html, /<script/i);
  const ru = maintenanceHtml("ru");
  assert.ok(ru.indexOf("обновляется") < ru.indexOf("is being updated"), "Russian first on ru.*");
  assert.match(ru, /<html lang="ru">/);
});

test("API and server-function calls get a short JSON 503, not the page", async () => {
  for (const request of [
    new Request("https://mail.cumuluscloud.app/api/account/export/t", { headers: { accept: "text/html" } }),
    new Request("https://mail.cumuluscloud.app/_serverFn/abc", { method: "POST", headers: { accept: "application/json" } }),
  ]) {
    const response = maintenanceResponse(request, "us");
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "maintenance", retryAfter: RETRY_AFTER_SECONDS });
  }
});
