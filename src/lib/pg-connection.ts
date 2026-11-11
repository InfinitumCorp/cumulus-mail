/**
 * Pass a Postgres URL through to `pg` unchanged, except configurations that
 * disable TLS. Hyperdrive's runtime string often has no `sslmode` because the
 * Worker talks to Hyperdrive. The origin URL (session pooler, port 5432) is
 * where `sslmode=require` belongs. Never set `rejectUnauthorized: false`.
 */
export function assertPgConnectionString(connectionString: string): string {
  const value = connectionString.trim();
  if (!value) throw new Error("Database connection string is empty");
  if (/sslmode=disable/i.test(value)) {
    throw new Error(
      "Refusing a database connection string with sslmode=disable. Use sslmode=require on the session pooler.",
    );
  }
  if (/rejectUnauthorized\s*[:=]\s*false/i.test(value)) {
    throw new Error("Refusing a database connection string that disables certificate checks.");
  }
  return value;
}
