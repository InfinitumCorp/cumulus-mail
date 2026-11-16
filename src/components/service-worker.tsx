import { useEffect } from "react";

/**
 * Registers public/sw.js (the offline shell) in production builds. It caches the offline page, icons
 * and hashed JS/CSS only, never page HTML or API responses, so no mail is ever stored on the device.
 * Dev skips it so Vite's module graph is never served from a cache.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // Not fatal: the app works without it, only the offline page is missing.
    });
  }, []);
  return null;
}
