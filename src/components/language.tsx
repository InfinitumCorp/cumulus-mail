import { useEffect } from "react";

/**
 * Interface language. Starts after hydration (so server and client markup match),
 * then translates the rendered UI from build-time catalogs and mounts the
 * language menu. Mail content is marked translate="no" and is never touched.
 */
export function Language() {
  useEffect(() => {
    void import("@/i18n/start.js");
  }, []);
  return null;
}
