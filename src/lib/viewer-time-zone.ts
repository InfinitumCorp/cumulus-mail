import { useEffect, useState } from "react";

/** The browser's time zone (an IANA name), or UTC when it cannot be read or is not one Intl accepts. */
export function detectTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!zone) return "UTC";
    new Intl.DateTimeFormat("en-GB", { timeZone: zone }).format(0);
    return zone;
  } catch {
    return "UTC";
  }
}

/**
 * The zone to show times in. "UTC" on the server and in the first client render, so the hydrated page
 * matches what the server sent; the viewer's own zone right after that.
 */
export function useViewerTimeZone(): string {
  const [zone, setZone] = useState("UTC");
  useEffect(() => setZone(detectTimeZone()), []);
  return zone;
}
