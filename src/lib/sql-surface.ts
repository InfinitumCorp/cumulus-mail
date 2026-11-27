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
  return pooledSql(pool).sql;
}

/** `poolSql`, plus whether the caller is inside one of its transactions right now. */
function pooledSql(pool: PoolLike): { sql: Sql; inTransaction: () => boolean } {
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
  return { sql, inTransaction: () => current.getStore() !== undefined };
}


/**
 * A pg Pool that is closed when its request ends. `pg.Pool` satisfies it.
 */
export type ClosablePool = PoolLike & { end(): Promise<void> };

type DbScope = {
  pool?: ClosablePool;
  pooled?: { sql: Sql; inTransaction: () => boolean };
  ended: boolean;
};

/**
 * On globalThis, not in module scope: the Nitro middleware that opens a scope and the app code that
 * reads it are bundled separately (the app is its own Vite environment), so each bundle has its own copy
 * of this module. Two AsyncLocalStorage objects would never see each other's scope.
 */
const scopeRef = globalThis as typeof globalThis & { __cumulusDbScopes__?: AsyncLocalStorage<DbScope> };
const scopes = (scopeRef.__cumulusDbScopes__ ??= new AsyncLocalStorage<DbScope>());

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
    // end() waits for checked-out connections (a transaction still running) to be released, then
    // closes every socket. `pooled` is kept so that transaction can finish on its own connection.
    if (scope.pool) void scope.pool.end().catch(() => undefined);
  }
}

/** The live scope, with its pool made on first use; undefined outside a scope or after it ended. */
function liveScope(makePool: () => ClosablePool): DbScope | undefined {
  const scope = scopes.getStore();
  if (!scope || scope.ended) return undefined;
  scope.pool ??= makePool();
  return scope;
}

/**
 * The `Sql` surface for Workers: each request uses its own pool (see `withDbScope`). A query made outside
 * any request scope, or after its request ended, gets a pool of its own, closed when that query settles.
 * A transaction still running when its request ends keeps its own connection. Transactions work as in
 * `poolSql`.
 */
export function requestScopedSql(makePool: () => ClosablePool): Sql {
  function withScopedSql<T>(work: (inner: Sql) => Promise<T>): Promise<T> {
    const current = scopes.getStore();
    if (current?.ended && current.pooled?.inTransaction()) return work(current.pooled.sql);
    const scope = liveScope(makePool);
    if (!scope) return withDbScope(() => withScopedSql(work));
    scope.pooled ??= pooledSql(scope.pool!);
    return work(scope.pooled.sql);
  }
  async function run<T>(text: string, params: unknown[]): Promise<T[]> {
    return withScopedSql((inner) => inner.query<T>(text, params));
  }
  async function transaction<T>(body: () => Promise<T>): Promise<T> {
    return withScopedSql((inner) => inner.transaction!(body));
  }
  const sql = toSql(run);
  sql.transaction = transaction;
  return sql;
}

/**
 * A pool-shaped object for libraries that hold on to a pool (Better Auth through Kysely): every
 * `connect()` and `query()` goes to the current request's pool, shared with `requestScopedSql` when both
 * use the same database. Outside a request scope, a connection gets a pool of its own that closes when
 * the connection is released. `end()` does nothing: the scope closes the real pools.
 */
export function requestScopedPool(makePool: () => ClosablePool): ClosablePool {
  async function query(text: string, params?: unknown[]) {
    const scope = liveScope(makePool);
    if (scope) return scope.pool!.query(text, params);
    return withDbScope(async () => liveScope(makePool)!.pool!.query(text, params));
  }
  async function connect(): Promise<PoolClientLike> {
    const scope = liveScope(makePool);
    if (scope) return scope.pool!.connect();
    const own = makePool();
    let client: PoolClientLike;
    try {
      client = await own.connect();
    } catch (error) {
      void own.end().catch(() => undefined);
      throw error;
    }
    return {
      query: (text, params) => client.query(text, params),
      release: (error) => {
        client.release(error);
        void own.end().catch(() => undefined);
      },
    };
  }
  return { query, connect, end: async () => undefined };
}
