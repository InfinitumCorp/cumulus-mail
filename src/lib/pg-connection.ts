/**
 * Pass a Postgres URL through to `pg` unchanged, except configurations that disable TLS to a real
 * database. Never set `rejectUnauthorized: false`.
 *
 * Two hosts may say `sslmode=disable`, because the connection never leaves the platform or machine:
 * - `<id>.hyperdrive.local`: the string Hyperdrive gives a Worker (`env.HYPERDRIVE.connectionString`),
 *   e.g. `postgres://user:pass@<id>.hyperdrive.local:5432/db?sslmode=disable`. The Worker talks to
 *   Hyperdrive inside Cloudflare; Hyperdrive makes the TLS connection to the origin, whose URL (session
 *   pooler, port 5432) is where `sslmode=require` belongs. Refusing this string would refuse every
 *   database connection on the Workers copy.
 * - loopback, for local runs.
 */
export function assertPgConnectionString(connectionString: string): string {
  const value = connectionString.trim();
  if (!value) throw new Error("Database connection string is empty");
  if (/sslmode=disable/i.test(value) && !isPlatformLocal(value)) {
    throw new Error(
      "Refusing a database connection string with sslmode=disable. Use sslmode=require on the session pooler.",
    );
  }
  if (/rejectUnauthorized\s*[:=]\s*false/i.test(value)) {
    throw new Error("Refusing a database connection string that disables certificate checks.");
  }
  return value;
}

function isPlatformLocal(value: string): boolean {
  try {
    const host = new URL(value).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (/^[0-9a-f]{32}\.hyperdrive\.local$/.test(host)) return true;
    return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}
