import { useEffect } from "react";

/**
 * Interface language. Translates the rendered UI from build-time catalogs and mounts the language
 * menu. Mail content is marked translate="no" and is never touched.
 *
 * The translator rewrites text nodes in place, so it must not start until React has finished
 * hydrating the server-rendered page: if it rewrites a node in a part of the page React has not
 * hydrated yet, React finds text that does not match what it rendered on the server and throws a
 * hydration error (seen as "Hydration failed … shared with Drive" in Russian browsers). A root effect
 * runs after the root hydrates, but parts of the page can hydrate later. So it waits for the page to
 * finish loading, then for the browser to go idle, then two frames, before starting.
 */
function afterHydration(start: () => void): () => void {
  let cancelled = false;
  const go = () => {
    if (cancelled) return;
    const idle = (window as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
    const next = () => requestAnimationFrame(() => requestAnimationFrame(() => !cancelled && start()));
    if (idle) idle(next, { timeout: 1500 });
    else setTimeout(next, 200);
  };
  if (document.readyState === "complete") go();
  else window.addEventListener("load", go, { once: true });
  return () => {
    cancelled = true;
    window.removeEventListener("load", go);
  };
}

export function Language() {
  useEffect(
    () =>
      afterHydration(() => {
        void import("@/i18n/start.js");
      }),
    [],
  );
  return null;
}
