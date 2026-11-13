/**
 * One JSON line per request, for Yandex Cloud Logging and Cloudflare Logpush (docs/deploy/logging.md).
 *
 * **No personal data and no bodies.** A log line has the method, a scrubbed path, the status, the
 * duration, the region and a request id. It never carries a query string, a cookie, an Authorization
 * header, a body, an email address or a client IP: a mail server's logs are exactly where those leak,
 * and a Russian deployment keeps them out of scope for 152-ФЗ in the first place.
 *
 * Off unless `MAIL_REQUEST_LOG=on`, so nothing changes for a deployment that has not asked for it.
 */
import type { Region } from "../region.ts";

export type RequestLogLine = {
  t: string;
  level: "info" | "warn" | "error";
  msg: "request";
  id: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  region: Region;
  commit: string;
};

export function requestLogEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.MAIL_REQUEST_LOG?.trim().toLowerCase() === "on";
}

/** An id for one request: the inbound one when a proxy set it, else a random one. */
export function requestId(headers: { get(name: string): string | null }, random: () => string = () => crypto.randomUUID()): string {
  for (const name of ["cf-ray", "x-request-id", "x-amzn-trace-id", "apigw-requestid"]) {
    const value = headers.get(name)?.trim();
    // A header is caller-controlled: take only something short and plain, never arbitrary text.
    if (value && /^[A-Za-z0-9=_:.-]{6,80}$/.test(value)) return value;
  }
  return random();
}

const ID_LIKE = /^(?:[0-9a-f-]{8,}|\d+|[A-Za-z0-9_-]{16,})$/;

/**
 * A path safe to log: the query string dropped, and any segment that looks like an id or a token
 * replaced. `/p/8f3c…` (a protected-message token) becomes `/p/:id`, so a log cannot be used to open
 * someone's message.
 */
export function scrubPath(rawPath: string): string {
  const path = rawPath.split("?")[0]!.split("#")[0]!;
  const segments = path.split("/").map((segment) => {
    if (!segment) return segment;
    if (segment.includes("@")) return ":addr";
    return ID_LIKE.test(segment) ? ":id" : segment;
  });
  const cleaned = segments.join("/").slice(0, 200);
  return cleaned || "/";
}

export function levelFor(status: number): RequestLogLine["level"] {
  if (status >= 500) return "error";
  if (status >= 400) return "warn";
  return "info";
}

export function requestLine(input: {
  id: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  region: Region;
  commit: string;
  now?: Date;
}): RequestLogLine {
  return {
    t: (input.now ?? new Date()).toISOString(),
    level: levelFor(input.status),
    msg: "request",
    id: input.id,
    method: input.method.slice(0, 10).toUpperCase(),
    path: scrubPath(input.path),
    status: input.status,
    ms: Math.max(0, Math.round(input.ms)),
    region: input.region,
    commit: input.commit,
  };
}

/** One line of JSON on stdout: what both Yandex Cloud Logging and Cloudflare Logpush collect. */
export function writeRequestLine(line: RequestLogLine, out: (text: string) => void = console.log): void {
  out(JSON.stringify(line));
}
