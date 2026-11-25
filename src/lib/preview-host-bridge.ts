/**
 * Guest side of the grok-web ↔ sandbox preview postMessage bridge.
 *
 * Activates only when this page is framed by an allowlisted Grok embedder.
 * Top-level runs (download/export, local `npm run dev`, deployed sites) noop.
 */

import { CONNECTOR_TOKEN_READY_EVENT } from "./app-data/types";
import { PREVIEW_BRIDGE_CHANNEL, PREVIEW_BRIDGE_VERSION, readEnvelope, readHostMessage } from "./preview-bridge-messages";
import { resolveParentEmbedderOrigin } from "./preview-embedder-origin";

export {
  isGrokEmbedderOrigin,
  isSandboxPreviewGuestHost,
  resolveParentEmbedderOrigin,
} from "./preview-embedder-origin";

export { PREVIEW_BRIDGE_CHANNEL, PREVIEW_BRIDGE_VERSION } from "./preview-bridge-messages";

export type PreviewHostBridgeOptions = {
  /** Prefer the app router when available; falls back to history.pushState. */
  navigate?: (path: string) => void;
  /** Best-effort registered paths for host autosuggest (may be empty). */
  getRoutePaths?: () => string[];
};

export function isSafeBridgePath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    return false;
  }
  try {
    const resolved = new URL(path, "https://preview.invalid");
    return resolved.origin === "https://preview.invalid";
  } catch {
    return false;
  }
}

/**
 * Origin of the Grok embedder framing this page, or null when the page runs
 * top-level (download/export, local `npm run dev`, deployed sites) or under a
 * non-Grok parent. Client-only; null during SSR.
 */
export function resolveCurrentEmbedderOrigin(): string | null {
  if (typeof window === "undefined") return null;
  const ancestorOrigin =
    typeof location.ancestorOrigins !== 'undefined' && location.ancestorOrigins.length > 0
      ? location.ancestorOrigins[0]
      : null;
  return resolveParentEmbedderOrigin(
    window.parent === window,
    document.referrer,
    ancestorOrigin,
    window.location.hostname,
  );
}

/**
 * Install host↔guest messaging. Returns a dispose function.
 * Noops (returns a no-op dispose) when not embedded under a Grok parent.
 */
export function installPreviewHostBridge(
  options: PreviewHostBridgeOptions = {},
): () => void {
  const parentOrigin = resolveCurrentEmbedderOrigin();
  if (parentOrigin === null) return () => {};

  const ROOT_STATE_KEY = "__grokPreviewBridgeRoot";
  const originalPushState = window.history.pushState.bind(window.history);
  const originalReplaceState = window.history.replaceState.bind(window.history);

  const isAtHistoryRoot = () => {
    const state = window.history.state;
    return Boolean(
      state && typeof state === "object" && state[ROOT_STATE_KEY] === true,
    );
  };

  // Floor for chrome Back: only the first install in a fresh history stack is
  // root. Full document navigations reinstall this bridge on a deep URL; if we
  // re-stamped that entry as root, Back would no-op while earlier in-preview
  // history still exists. Preserve an existing tag (bfcache / SPA remount).
  try {
    const current = window.history.state;
    const alreadyTagged =
      current !== null &&
      typeof current === "object" &&
      Object.prototype.hasOwnProperty.call(current, ROOT_STATE_KEY);
    if (!alreadyTagged) {
      const isRoot = window.history.length <= 1;
      const marked =
        current && typeof current === "object"
          ? { ...current, [ROOT_STATE_KEY]: isRoot }
          : { [ROOT_STATE_KEY]: isRoot };
      originalReplaceState(marked, "", window.location.href);
    }
  } catch {
    // ignore if the document cannot be marked
  }

  const post = (message: object) => {
    window.parent.postMessage(message, parentOrigin);
  };

  const reportLocation = () => {
    post({
      channel: PREVIEW_BRIDGE_CHANNEL,
      version: PREVIEW_BRIDGE_VERSION,
      type: "location",
      path: window.location.pathname || "/",
      search: window.location.search,
      hash: window.location.hash,
    });
  };

  const reportRoutes = () => {
    const paths = options.getRoutePaths?.() ?? [];
    post({
      channel: PREVIEW_BRIDGE_CHANNEL,
      version: PREVIEW_BRIDGE_VERSION,
      type: "routes",
      paths,
    });
  };

  const defaultNavigate = (path: string) => {
    if (!isSafeBridgePath(path)) return;
    try {
      const url = new URL(path, window.location.origin);
      if (url.origin !== window.location.origin) return;
      const next = `${url.pathname}${url.search}${url.hash}`;
      window.history.pushState(window.history.state, "", next);
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
    } catch {
      // ignore malformed paths
    }
  };

  const navigate = (path: string) => {
    if (!isSafeBridgePath(path)) return;
    if (options.navigate) {
      options.navigate(path);
      return;
    }
    defaultNavigate(path);
  };

  const announce = () => {
    reportLocation();
    reportRoutes();
    post({
      channel: PREVIEW_BRIDGE_CHANNEL,
      version: PREVIEW_BRIDGE_VERSION,
      type: "ready",
    });
  };

  const onMessage = (event: MessageEvent) => {
    if (event.source !== window.parent) return;
    if (event.origin !== parentOrigin) return;

    const envelope = readEnvelope(event.data);
    if (!envelope || envelope.version !== PREVIEW_BRIDGE_VERSION) return;
    const message = readHostMessage(event.data);
    if (!message) return;
    switch (message.type) {
      // Host re-handshake: it may have (re)mounted after our install-time announce, or asked before we
      // hydrated. Announce again.
      case "hello":
        announce();
        return;
      case "navigate":
        navigate(message.path);
        // Router navigations often update location asynchronously; report after a tick.
        queueMicrotask(reportLocation);
        return;
      case "history":
        // Do not history.go(-1) off the first entry — that leaves the preview.
        if (message.delta === -1 && isAtHistoryRoot()) return;
        // Location sync comes from the popstate listener once history settles.
        window.history.go(message.delta);
        return;
      case "connector-token-ready":
        window.dispatchEvent(new Event(CONNECTOR_TOKEN_READY_EVENT));
        return;
    }
  };

  const onPopState = () => {
    reportLocation();
  };

  // Same-document `#` navigations fire hashchange, not popstate / pushState.
  const onHashChange = () => {
    reportLocation();
  };

  // Patch history so in-app SPA navigations sync the host address bar.
  window.history.pushState = (data, unused, url) => {
    const next =
      data && typeof data === "object"
        ? { ...data, [ROOT_STATE_KEY]: false }
        : data;
    originalPushState(next, unused, url);
    reportLocation();
  };
  window.history.replaceState = (data, unused, url) => {
    const next =
      isAtHistoryRoot()
        ? {
            ...(data && typeof data === "object" ? data : {}),
            [ROOT_STATE_KEY]: true,
          }
        : data;
    originalReplaceState(next, unused, url);
    reportLocation();
  };

  window.addEventListener("message", onMessage);
  window.addEventListener("popstate", onPopState);
  window.addEventListener("hashchange", onHashChange);

  announce();

  return () => {
    window.removeEventListener("message", onMessage);
    window.removeEventListener("popstate", onPopState);
    window.removeEventListener("hashchange", onHashChange);
    window.history.pushState = originalPushState;
    window.history.replaceState = originalReplaceState;
  };
}

/** Collect static path patterns from a TanStack route tree (best-effort). */
export function collectRoutePathsFromTree(routeTree: unknown): string[] {
  const paths = new Set<string>();

  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const record = node as {
      fullPath?: unknown;
      path?: unknown;
      children?: unknown;
    };
    const full =
      typeof record.fullPath === "string"
        ? record.fullPath
        : typeof record.path === "string"
          ? record.path
          : null;
    if (full !== null && full !== "") {
      paths.add(full.startsWith("/") ? full : `/${full}`);
    } else if (full === "") {
      paths.add("/");
    }
    const children = record.children;
    if (Array.isArray(children)) {
      for (const child of children) walk(child);
    } else if (children && typeof children === "object") {
      for (const child of Object.values(children as Record<string, unknown>)) {
        walk(child);
      }
    }
  };

  walk(routeTree);
  return [...paths];
}
