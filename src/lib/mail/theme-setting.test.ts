import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultSettings, sanitizeSettings, THEMES } from "./settings.ts";

test("appearance: a new mailbox follows the device", () => {
  assert.equal(defaultSettings().theme, "system");
  assert.equal(THEMES[0], "system", "the first theme is the default the UI falls back to");
});

test("appearance: light and dark are kept; anything else (old rows, junk) means follow the device", () => {
  for (const theme of ["light", "dark", "system"]) {
    assert.equal(sanitizeSettings({ ...defaultSettings(), theme }).theme, theme);
  }
  for (const theme of [undefined, null, "", "Dark", "solarized", 1, { dark: true }]) {
    assert.equal(sanitizeSettings({ ...defaultSettings(), theme }).theme, "system", String(theme));
  }
  const { theme: _omitted, ...older } = defaultSettings();
  assert.equal(sanitizeSettings(older).theme, "system", "settings saved before this field existed");
});
