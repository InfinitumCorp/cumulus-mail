import { withDbScope } from "../../src/lib/sql-surface.ts";

/**
 * Every request runs in its own database scope (src/lib/sql-surface.ts `withDbScope`). On Workers that
 * gives the request its own Postgres pool, closed when the request ends: a socket opened by one request
 * cannot be used by another there. Elsewhere no scoped pool is made and this costs nothing. Named so it
 * runs after cloudflare-bindings.ts and before wkd.ts, which queries the database.
 */
export default function dbScope(_event: unknown, next: () => unknown | Promise<unknown>): Promise<unknown> {
  return withDbScope(async () => next());
}
