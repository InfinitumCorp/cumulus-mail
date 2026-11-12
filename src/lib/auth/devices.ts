/**
 * "Signed-in devices" for the account dialog. Better Auth keeps one session row per sign-in, with the
 * user agent and IP it saw; these helpers turn those rows into something a person can recognise.
 * Dependency-free so it can be tested and used on the client.
 */
export type SessionLike = {
  id: string;
  token: string;
  createdAt: string | Date;
  updatedAt: string | Date;
  expiresAt: string | Date;
  userAgent?: string | null;
  ipAddress?: string | null;
};

export type DeviceRow = {
  id: string;
  token: string;
  device: string;
  detail: string;
  current: boolean;
};

const BROWSERS: Array<[RegExp, string]> = [
  [/Edg(?:e|A|iOS)?\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/SamsungBrowser\//, "Samsung Internet"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/Chrome\/|CriOS\//, "Chrome"],
  [/Safari\//, "Safari"],
];

const SYSTEMS: Array<[RegExp, string]> = [
  [/iPhone/, "iPhone"],
  [/iPad/, "iPad"],
  [/Android/, "Android"],
  [/CrOS/, "ChromeOS"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/Windows/, "Windows"],
  [/Linux/, "Linux"],
];

/** "Chrome on macOS", "Safari on iPhone", or "Unknown device". */
export function describeDevice(userAgent: string | null | undefined): string {
  const ua = userAgent?.trim() ?? "";
  if (!ua) return "Unknown device";
  const browser = BROWSERS.find(([pattern]) => pattern.test(ua))?.[1];
  const system = SYSTEMS.find(([pattern]) => pattern.test(ua))?.[1];
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system ?? "Unknown device";
}

function when(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function shortDate(date: Date): string {
  return Number.isNaN(date.getTime())
    ? "unknown"
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/**
 * Rows for the list: expired sessions dropped, this device first, then most recently active. The IP is
 * shown only as its first parts (enough to tell places apart, not a full address on screen).
 */
export function deviceRows(sessions: SessionLike[], currentId: string | null, now = new Date()): DeviceRow[] {
  return sessions
    .filter((session) => when(session.expiresAt).getTime() > now.getTime())
    .sort((a, b) => {
      if (a.id === currentId) return -1;
      if (b.id === currentId) return 1;
      return when(b.updatedAt).getTime() - when(a.updatedAt).getTime();
    })
    .map((session) => {
      const current = session.id === currentId;
      const place = maskIp(session.ipAddress);
      const parts = [current ? "This device" : `Active ${shortDate(when(session.updatedAt))}`];
      parts.push(`signed in ${shortDate(when(session.createdAt))}`);
      if (place) parts.push(place);
      return { id: session.id, token: session.token, device: describeDevice(session.userAgent), detail: parts.join(" · "), current };
    });
}

/** `203.0.113.7` -> `203.0.113.x`; `2001:db8:1:2::5` -> `2001:db8:1:…`. */
export function maskIp(ip: string | null | undefined): string {
  const value = ip?.trim() ?? "";
  if (!value) return "";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return `${value.split(".").slice(0, 3).join(".")}.x`;
  if (value.includes(":")) return `${value.split(":").slice(0, 3).join(":")}:…`;
  return "";
}
