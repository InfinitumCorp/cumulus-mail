import { THEMES, type Theme } from "./theme-names.ts";

/**
 * Light / dark / follow the device. The colours themselves are CSS (src/styles.css: dark tokens under
 * `prefers-color-scheme: dark`, overridden by `data-theme` on <html>). The choice is a mail setting, so
 * it follows the owner to every device; it is also kept in this browser's localStorage so the next
 * load can apply it before the mailbox has loaded. "system" stores nothing and sets no attribute.
 */
const STORAGE_KEY = "cumulus-mail-theme";
const BACKGROUND = { light: "#ffffff", dark: "#0f1419" } as const;
const FOLLOW_DEVICE: Theme = THEMES[0];

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
}

/** Puts `theme` on the page: the <html> attribute, the browser chrome colour, and this device's copy. */
export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  const dark = theme === "dark" || (theme === "system" && systemPrefersDark());
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? BACKGROUND.dark : BACKGROUND.light);
  try {
    if (theme === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Storage blocked (private mode): the setting still applies once the mailbox loads.
  }
}

/** The choice remembered on this device, or "system". */
export function storedTheme(): Theme {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : FOLLOW_DEVICE;
  } catch {
    return FOLLOW_DEVICE;
  }
}
