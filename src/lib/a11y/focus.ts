import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Visible, focusable elements inside `root`, in tab order. */
export function focusables(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true",
  );
}

/**
 * Which element Tab should move to from `current`, or null to let the browser
 * handle it. Wraps at both ends so focus stays inside the dialog.
 */
export function nextTrapTarget<T>(items: T[], current: T | null, backwards: boolean): T | null {
  if (items.length === 0) return null;
  const index = current === null ? -1 : items.indexOf(current);
  if (index === -1) return backwards ? items[items.length - 1]! : items[0]!;
  if (backwards && index === 0) return items[items.length - 1]!;
  if (!backwards && index === items.length - 1) return items[0]!;
  return null;
}

/**
 * Modal dialog focus: move focus in when it opens, keep Tab inside, close on
 * Escape, and give focus back to whatever had it before.
 */
export function useDialogFocus<T extends HTMLElement>(open: boolean, onClose?: () => void): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = ref.current;
    if (root && !root.contains(document.activeElement)) {
      const preferred = root.querySelector<HTMLElement>("[data-autofocus]") ?? focusables(root)[0] ?? root;
      if (preferred === root && !root.hasAttribute("tabindex")) root.setAttribute("tabindex", "-1");
      preferred.focus();
    }
    function onKey(event: KeyboardEvent) {
      const node = ref.current;
      if (!node) return;
      if (event.key === "Escape" && close.current) {
        event.preventDefault();
        event.stopPropagation();
        close.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables(node);
      const active = document.activeElement instanceof HTMLElement && node.contains(document.activeElement) ? document.activeElement : null;
      const target = nextTrapTarget(items, active, event.shiftKey);
      if (target) {
        event.preventDefault();
        target.focus();
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [open]);
  return ref;
}
