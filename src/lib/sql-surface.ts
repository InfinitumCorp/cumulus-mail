import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Minimal shared SQL surface, satisfied by both Neon and PGLite. Both the
 * tagged-template and `.query()` forms resolve to an array of row objects:
 *
 *   const sql = await getSql();
 *   const rows = await sql`select * from todos where id = ${id}`; // parameterized
 *   const rows2 = await sql.query("select * from todos where id = $1", [id]);
 */
export interface Sql {
  <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  /**
   * Runs `run` as one transaction on one connection; every query made inside it (through this Sql) goes to
   * that connection. Present on the pooled Postgres path. A pool hands each `query()` to whichever
   * connection is free, so BEGIN … COMMIT sent as separate queries is not a transaction there.
   */
  transaction?<T>(run: () => Promise<T>): Promise<T>;
}

type Run = <T>(text: string, params: unknown[]) => Promise<T[]>;

/** Wrap a query runner in the tagged-template + `.query()` `Sql` surface. */
export function toSql(run: Run): Sql {
  const sql = (async <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]> => {
    // Rebuild with $1, $2, … placeholders so values stay parameterized.
    let text = strings[0];
    for (let i = 0; i < values.length; i += 1) text += `$${i + 1}${strings[i + 1]}`;
    return run<T>(text, values);
  }) as unknown as Sql;
  sql.query = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    run<T>(text, params);
  return sql;
}


type PoolClientLike = {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(error?: unknown): void;
};
export type PoolLike = {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  connect(): Promise<PoolClientLike>;
};

/** The Sql surface over a pg Pool, with real transactions (see `Sql.transaction`). Exported for tests. */
export function poolSql(pool: PoolLike): Sql {
  const current = new AsyncLocalStorage<PoolClientLike>();
  const sql = toSql(async <T>(text: string, params: unknown[]) => {
    const client = current.getStore();
    const res = client ? await client.query(text, params) : await pool.query(text, params);
    return res.rows as T[];
  });
  sql.transaction = async <T>(run: () => Promise<T>): Promise<T> => {
    // Already inside one: join it (a nested BEGIN would only warn and commit early).
    if (current.getStore()) return run();
    const client = await pool.connect();
    let broken: unknown;
    try {
      await client.query("BEGIN");
      const value = await current.run(client, run);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        // The connection is unusable: tell the pool to discard it.
        broken = rollbackError;
      }
      throw error;
    } finally {
      client.release(broken);
    }
  };
  return sql;
}

