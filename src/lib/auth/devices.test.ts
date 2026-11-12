import assert from "node:assert/strict";
import { test } from "node:test";
import { describeDevice, deviceRows, maskIp } from "./devices.ts";

const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const WIN_EDGE =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
const ANDROID_FIREFOX = "Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0";

test("user agents read as a browser on a system", () => {
  assert.equal(describeDevice(MAC_CHROME), "Chrome on macOS");
  assert.equal(describeDevice(IPHONE_SAFARI), "Safari on iPhone");
  assert.equal(describeDevice(WIN_EDGE), "Edge on Windows");
  assert.equal(describeDevice(ANDROID_FIREFOX), "Firefox on Android");
  assert.equal(describeDevice("curl/8.5.0"), "Unknown device");
  assert.equal(describeDevice(null), "Unknown device");
});

test("IP addresses are shortened, never shown in full", () => {
  assert.equal(maskIp("203.0.113.7"), "203.0.113.x");
  assert.equal(maskIp("2001:db8:1:2::5"), "2001:db8:1:…");
  assert.equal(maskIp(""), "");
  assert.equal(maskIp("not-an-ip"), "");
});

test("this device first, then most recent; expired sessions are left out", () => {
  const now = new Date("2026-11-12T12:00:00Z");
  const base = { createdAt: "2026-11-01T09:00:00Z", expiresAt: "2026-12-01T00:00:00Z" };
  const rows = deviceRows(
    [
      { ...base, id: "old", token: "t-old", updatedAt: "2026-11-05T10:00:00Z", userAgent: WIN_EDGE, ipAddress: "198.51.100.4" },
      { ...base, id: "gone", token: "t-gone", updatedAt: "2026-11-11T10:00:00Z", expiresAt: "2026-11-10T00:00:00Z" },
      { ...base, id: "phone", token: "t-phone", updatedAt: "2026-11-11T10:00:00Z", userAgent: IPHONE_SAFARI },
      { ...base, id: "me", token: "t-me", updatedAt: "2026-11-02T10:00:00Z", userAgent: MAC_CHROME, ipAddress: "203.0.113.7" },
    ],
    "me",
    now,
  );
  assert.deepEqual(
    rows.map((row) => [row.id, row.device, row.current, row.detail]),
    [
      ["me", "Chrome on macOS", true, "This device · signed in Nov 1, 2026 · 203.0.113.x"],
      ["phone", "Safari on iPhone", false, "Active Nov 11, 2026 · signed in Nov 1, 2026"],
      ["old", "Edge on Windows", false, "Active Nov 5, 2026 · signed in Nov 1, 2026 · 198.51.100.x"],
    ],
  );
});
