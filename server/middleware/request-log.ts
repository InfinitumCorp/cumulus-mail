import { buildCommit } from "../../src/lib/health.ts";
import { regionFor } from "../../src/lib/region.ts";
import { requestId, requestLine, requestLogEnabled, writeRequestLine } from "../../src/lib/observability/request-log.ts";

/**
 * One JSON line per request when `MAIL_REQUEST_LOG=on`. See src/lib/observability/request-log.ts for
 * what a line may contain (no bodies, no query strings, no addresses, no IPs).
 */
type LogEvent = { url: URL; req: { method?: string; headers: Headers } };

export default async function requestLog(event: LogEvent, next: () => unknown | Promise<unknown>): Promise<unknown> {
  if (!requestLogEnabled()) return next();
  const started = Date.now();
  const id = requestId(event.req.headers);
  let status = 200;
  try {
    const result = await next();
    if (result instanceof Response) status = result.status;
    return result;
  } catch (error) {
    status = 500;
    throw error;
  } finally {
    writeRequestLine(
      requestLine({
        id,
        method: event.req.method ?? "GET",
        path: event.url.pathname,
        status,
        ms: Date.now() - started,
        region: regionFor(event.req.headers.get("host")),
        commit: buildCommit(),
      }),
    );
  }
}
