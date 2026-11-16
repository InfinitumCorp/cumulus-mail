import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_THEME } from "../theme-names.ts";
import { defaultSettings, sanitizeSettings } from "./settings.ts";

test("appearance: a mailbox is light unless its owner chooses otherwise (the layout rule)", () => {
  assert.equal(DEFAULT_THEME, "light");
  assert.equal(defaultSettings().theme, "light");
});

test("appearance: light, dark and system are kept; anything else (old rows, junk) means light", () => {
  for (const theme of ["light", "dark", "system"]) {
    assert.equal(sanitizeSettings({ ...defaultSettings(), theme }).theme, theme);
  }
  for (const theme of [undefined, null, "", "Dark", "solarized", 1, { dark: true }]) {
    assert.equal(sanitizeSettings({ ...defaultSettings(), theme }).theme, "light", String(theme));
  }
  const { theme: _omitted, ...older } = defaultSettings();
  assert.equal(sanitizeSettings(older).theme, "light", "settings saved before this field existed");
});
