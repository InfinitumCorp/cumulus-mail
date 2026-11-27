export interface MailQuery {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  /** One connection for the whole transaction (src/lib/db.ts poolSql). Without it, BEGIN/COMMIT are sent as queries. */
  transaction?<T>(run: () => Promise<T>): Promise<T>;
}

/**
 * Runs `run` in a transaction. On a pooled connection (production) it must use `db.transaction`: a pool can
 * send each statement to a different connection, so BEGIN … COMMIT as separate queries would leave a save's
 * delete-and-reinsert unprotected, and could put another request's statements inside it. The plain form
 * stays for single-connection databases (PGLite in tests and local development).
 */
export async function withTransaction<T>(db: MailQuery, run: () => Promise<T>): Promise<T> {
  if (db.transaction) return db.transaction(run);
  await db.query("BEGIN");
  try {
    const value = await run();
    await db.query("COMMIT");
    return value;
  } catch (error) {
    try {
      await db.query("ROLLBACK");
    } catch {
      // Keep the original failure when the connection is already closed.
    }
    throw error;
  }
}
