import { useLayoutEffect } from "react";
import { applyTheme, storedTheme } from "@/lib/theme";

/** Applies this device's remembered choice as early as React allows, and keeps the chrome colour in step with the device. */
export function ThemeBoot() {
  useLayoutEffect(() => {
    applyTheme(storedTheme());
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const follow = () => {
      if (document.documentElement.getAttribute("data-theme") === "system") applyTheme("system");
    };
    media?.addEventListener?.("change", follow);
    return () => media?.removeEventListener?.("change", follow);
  }, []);
  return null;
}
