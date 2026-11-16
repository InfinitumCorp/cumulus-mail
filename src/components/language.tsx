import { useEffect, useRef } from "react";

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

/**
 * The header's language slot (`#lang-switch`). src/i18n/start.js mounts the menu here when the page
 * has the slot when it starts, and floats it bottom-left otherwise (sign-in, legal and share pages).
 * The menu starts once per page load, so this also adopts a menu that is already floating (the page
 * was opened elsewhere and navigated here), and hands it back to a floating box when the slot goes
 * away, so every page keeps one menu. Moving the <select> keeps its listeners.
 */
export function LanguageSlot({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const slot = ref.current;
    if (!slot) return;
    const adopt = () => {
      const float = document.querySelector(".lang-float");
      const menu = float?.querySelector("select.lang-switch");
      if (!float || !menu) return;
      slot.append(menu);
      float.remove();
    };
    adopt();
    const observer = new MutationObserver(adopt);
    observer.observe(document.body, { childList: true });
    return () => {
      observer.disconnect();
      const menu = slot.querySelector("select.lang-switch");
      if (!menu) return;
      const float = document.createElement("div");
      float.className = "lang-float";
      float.append(menu);
      document.body.append(float);
    };
  }, []);
  return <div id="lang-switch" ref={ref} className={className} />;
}
