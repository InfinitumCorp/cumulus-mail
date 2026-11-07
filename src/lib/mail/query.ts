export interface MailQuery {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

export async function withTransaction<T>(db: MailQuery, run: () => Promise<T>): Promise<T> {
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
