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
      // A transaction left open (a request that never settles) gives its connection back after 30 s of
      // silence instead of holding one of the pool's few connections forever.
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
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


/**
 * A pg Pool that is closed when its request ends. `pg.Pool` satisfies it.
 */
export type ClosablePool = PoolLike & { end(): Promise<void> };

type DbScope = { pool?: ClosablePool; sql?: Sql; ended: boolean };
const scopes = new AsyncLocalStorage<DbScope>();

/**
 * Runs `run` with its own database connections. On Workers a socket belongs to the request that opened
 * it: a pool kept in module scope hands request B an idle connection from request A, and workerd then
 * never answers B (it cancels it as hung). So on Workers every request gets its own pool, made on its
 * first query and closed when `run` settles. `server/middleware/db-scope.ts` wraps every request in one.
 */
export async function withDbScope<T>(run: () => Promise<T>): Promise<T> {
  const scope: DbScope = { ended: false };
  try {
    return await scopes.run(scope, run);
  } finally {
    scope.ended = true;
    const pool = scope.pool;
    scope.pool = undefined;
    scope.sql = undefined;
    // end() waits for checked-out connections to be released, then closes every socket.
    if (pool) void pool.end().catch(() => undefined);
  }
}

/** The live scope's pool, made on first use; undefined outside a scope or after it ended. */
function scopePool(makePool: () => ClosablePool): DbScope | undefined {
  const scope = scopes.getStore();
  if (!scope || scope.ended) return undefined;
  scope.pool ??= makePool();
  return scope;
}

/**
 * The `Sql` surface for Workers: each request uses its own pool (see `withDbScope`). A query made outside
 * any request scope (or after its request ended) gets a pool of its own, closed when that query settles.
 * Transactions work as in `poolSql`.
 */
export function requestScopedSql(makePool: () => ClosablePool): Sql {
  const use = <T>(work: (sql: Sql) => Promise<T>): Promise<T> => {
    const scope = scopePool(makePool);
    if (!scope) return withDbScope(() => use(work));
    scope.sql ??= poolSql(scope.pool!);
    return work(scope.sql);
  };
  const sql = toSql(<T>(text: string, params: unknown[]) => use((inner) => inner.query<T>(text, params)));
  sql.transaction = <T>(run: () => Promise<T>) => use((inner) => inner.transaction!(run));
  return sql;
}

/**
 * A pool-shaped object for libraries that hold on to a pool (Better Auth through Kysely): every
 * `connect()` and `query()` goes to the current request's pool, shared with `requestScopedSql` when both
 * use the same database. Outside a request scope, a connection gets a pool of its own that closes when
 * the connection is released. `end()` does nothing: the scope closes the real pools.
 */
export function requestScopedPool(makePool: () => ClosablePool): ClosablePool {
  return {
    query: async (text, params) => {
      const scope = scopePool(makePool);
      if (scope) return scope.pool!.query(text, params);
      return withDbScope(async () => scopePool(makePool)!.pool!.query(text, params));
    },
    connect: async () => {
      const scope = scopePool(makePool);
      if (scope) return scope.pool!.connect();
      const own = makePool();
      const client = await own.connect();
      return {
        query: (text, params) => client.query(text, params),
        release: (error) => {
          client.release(error);
          void own.end().catch(() => undefined);
        },
      };
    },
    end: async () => undefined,
  };
}
