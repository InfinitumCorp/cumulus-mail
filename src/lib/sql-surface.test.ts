import assert from "node:assert/strict";
import { test } from "node:test";
import { poolSql, requestScopedPool, requestScopedSql, withDbScope, type ClosablePool, type PoolLike } from "./sql-surface.ts";
import { withTransaction } from "./mail/query.ts";

/** A pool that hands every pool.query() to a different connection, as a busy pg Pool can. */
function fakePool() {
  const log: string[] = [];
  let next = 0;
  const released: Array<{ id: string; error: unknown }> = [];
  const pool: PoolLike = {
    query: async (text) => {
      log.push(`pool-${next++}: ${text}`);
      return { rows: [] };
    },
    connect: async () => {
      const id = `client-${next++}`;
      return {
        query: async (text) => {
          log.push(`${id}: ${text}`);
          if (text === "fail") throw new Error("boom");
          return { rows: [] };
        },
        release: (error) => released.push({ id, error }),
      };
    },
  };
  return { pool, log, released };
}

test("a transaction runs BEGIN, every statement inside it and COMMIT on one connection", async () => {
  const { pool, log, released } = fakePool();
  const sql = poolSql(pool);
  const db = { query: sql.query, transaction: sql.transaction!.bind(sql) };
  await withTransaction(db, async () => {
    await db.query("delete from messages");
    await db.query("insert into messages");
  });
  await db.query("select outside");
  assert.deepEqual(log, ["client-0: BEGIN", "client-0: SET LOCAL idle_in_transaction_session_timeout = '30s'", "client-0: delete from messages", "client-0: insert into messages", "client-0: COMMIT", "pool-1: select outside"]);
  assert.deepEqual(released, [{ id: "client-0", error: undefined }]);
});

test("a failure rolls back on the same connection; a nested transaction joins the outer one", async () => {
  const { pool, log, released } = fakePool();
  const sql = poolSql(pool);
  const db = { query: sql.query, transaction: sql.transaction!.bind(sql) };
  await assert.rejects(() =>
    withTransaction(db, async () => {
      await withTransaction(db, async () => db.query("inner"));
      await db.query("fail");
    }),
  );
  assert.deepEqual(log, ["client-0: BEGIN", "client-0: SET LOCAL idle_in_transaction_session_timeout = '30s'", "client-0: inner", "client-0: fail", "client-0: ROLLBACK"]);
  assert.equal(released.length, 1);
});

test("queries from another request during a transaction stay out of it", async () => {
  const { pool, log } = fakePool();
  const sql = poolSql(pool);
  const db = { query: sql.query, transaction: sql.transaction!.bind(sql) };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const tx = withTransaction(db, async () => {
    await db.query("in tx");
    await gate;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await db.query("other request");
  release();
  await tx;
  assert.ok(log.some((line) => line.startsWith("pool-") && line.endsWith("other request")));
  assert.ok(log.includes("client-0: in tx"));
});

test("without a transaction method (PGLite) the plain BEGIN/COMMIT form is kept", async () => {
  const seen: string[] = [];
  await withTransaction({ query: async (text: string) => (seen.push(text), []) }, async () => undefined);
  assert.deepEqual(seen, ["BEGIN", "COMMIT"]);
});

// Against a real Postgres when CI provides one (MAIL_RUNTIME_DATABASE_URL), with a real pg Pool: a
// transaction that fails part way leaves nothing behind, even while other requests use the pool.
const realUrl = process.env.MAIL_RUNTIME_DATABASE_URL?.trim();
test("on a real pg Pool, a failed transaction leaves nothing behind under concurrency", { skip: !realUrl }, async () => {
  const pg = await import("pg");
  const pool = new pg.default.Pool({ connectionString: realUrl, max: 4 });
  try {
    const sql = poolSql(pool as unknown as PoolLike);
    const db = { query: sql.query, transaction: sql.transaction!.bind(sql) };
    await pool.query("drop table if exists public.tx_probe_shared");
    await pool.query("create table public.tx_probe_shared (n int)");
    // Eight other requests keep the four connections busy throughout. With BEGIN/COMMIT sent as separate
    // pool queries, this left about half the "rolled back" rows behind (95 of 200 in a local run).
    let running = true;
    const others = Promise.all(Array.from({ length: 8 }, async () => {
      while (running) await db.query("select pg_sleep(0.002)");
    }));
    for (let round = 0; round < 20; round += 1) {
      await assert.rejects(() =>
        withTransaction(db, async () => {
          for (let i = 0; i < 10; i += 1) await db.query("insert into public.tx_probe_shared values ($1)", [i]);
          throw new Error("fail part way");
        }),
      );
    }
    running = false;
    await others;
    const rows = await db.query<{ count: string }>("select count(*)::text as count from public.tx_probe_shared");
    assert.equal(rows[0]!.count, "0");
    await pool.query("drop table public.tx_probe_shared");
  } finally {
    await pool.end();
  }
});

/** Pools made by a factory, each recording its queries and whether it was closed. */
function poolFactory() {
  const made: Array<{ id: number; log: string[]; ended: boolean; out: number }> = [];
  const make = (): ClosablePool => {
    const entry = { id: made.length, log: [] as string[], ended: false, out: 0 };
    made.push(entry);
    return {
      query: async (text) => {
        assert.equal(entry.ended, false, "no query on a closed pool");
        entry.log.push(text);
        return { rows: [] };
      },
      connect: async () => {
        assert.equal(entry.ended, false, "no connect on a closed pool");
        entry.out += 1;
        return {
          query: async (text) => {
            entry.log.push(`tx: ${text}`);
            return { rows: [] };
          },
          release: () => {
            entry.out -= 1;
          },
        };
      },
      end: async () => {
        entry.ended = true;
      },
    };
  };
  return { make, made };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("Workers: each request scope gets its own pool, closed when the request ends", async () => {
  const { make, made } = poolFactory();
  const sql = requestScopedSql(make);
  const auth = requestScopedPool(make);
  await withDbScope(async () => {
    await sql.query("a1");
    await sql`select ${1}`;
    // Better Auth's connections come from the same request's pool.
    const client = await auth.connect();
    await client.query("auth");
    client.release();
  });
  await withDbScope(async () => {
    await sql.query("b1");
  });
  await settle();
  assert.equal(made.length, 2, "one pool per request, never shared");
  assert.deepEqual(made[0].log, ["a1", "select $1", "tx: auth"]);
  assert.deepEqual(made[1].log, ["b1"]);
  assert.ok(made.every((pool) => pool.ended), "both pools closed");
});

test("Workers: two requests running at once never share a pool", async () => {
  const { make, made } = poolFactory();
  const sql = requestScopedSql(make);
  const request = (name: string) =>
    withDbScope(async () => {
      for (let i = 0; i < 3; i += 1) {
        await sql.query(`${name}${i}`);
        await settle();
      }
    });
  await Promise.all([request("a"), request("b")]);
  assert.equal(made.length, 2);
  const logs = made.map((pool) => pool.log.join(",")).sort();
  assert.deepEqual(logs, ["a0,a1,a2", "b0,b1,b2"]);
});

test("Workers: a transaction inside a request runs on one connection of that request's pool", async () => {
  const { make, made } = poolFactory();
  const sql = requestScopedSql(make);
  await withDbScope(async () => {
    await sql.transaction!(async () => {
      await sql.query("delete");
      await sql.query("insert");
    });
    await sql.query("after");
  });
  await settle();
  assert.equal(made.length, 1);
  assert.deepEqual(made[0].log, [
    "tx: BEGIN",
    "tx: SET LOCAL idle_in_transaction_session_timeout = '30s'",
    "tx: delete",
    "tx: insert",
    "tx: COMMIT",
    "after",
  ]);
  assert.equal(made[0].out, 0, "the connection went back");
});

test("Workers: outside a request, or after it ended, each call gets a pool of its own that closes", async () => {
  const { make, made } = poolFactory();
  const sql = requestScopedSql(make);
  const auth = requestScopedPool(make);
  await sql.query("loose");
  await sql.transaction!(async () => {
    await sql.query("in tx");
  });
  const client = await auth.connect();
  await client.query("auth loose");
  client.release();
  await settle();
  assert.equal(made.length, 3);
  assert.deepEqual(made[1].log, ["tx: BEGIN", "tx: SET LOCAL idle_in_transaction_session_timeout = '30s'", "tx: in tx", "tx: COMMIT"]);
  assert.ok(made.every((pool) => pool.ended));

  // A query started by a request but run after the request ended does not reuse its closed pool.
  let late: Promise<unknown> | undefined;
  await withDbScope(async () => {
    await sql.query("in request");
    late = settle().then(() => sql.query("late"));
  });
  await late;
  await settle();
  assert.equal(made.length, 5);
  assert.deepEqual(made[3].log, ["in request"]);
  assert.deepEqual(made[4].log, ["late"]);
  assert.ok(made.every((pool) => pool.ended));
});

test("Workers: the scope is shared by separate copies of this module (the server and app bundles)", async () => {
  // A second module instance, as when Nitro's middleware and the app are bundled separately.
  const copy = (await import(`./sql-surface.ts?copy=${Date.now()}`)) as typeof import("./sql-surface.ts");
  assert.notEqual(copy.withDbScope, withDbScope, "a separate module instance");
  const { make, made } = poolFactory();
  const sql = requestScopedSql(make);
  const auth = requestScopedPool(make);
  await copy.withDbScope(async () => {
    await sql.query("one");
    await sql.query("two");
    const client = await auth.connect();
    await client.query("auth");
    client.release();
  });
  await settle();
  assert.equal(made.length, 1, "one pool for the whole request");
  assert.deepEqual(made[0].log, ["one", "two", "tx: auth"]);
  assert.equal(made[0].ended, true);
});

test("Workers: a transaction still running when its request ends finishes on its own connection", async () => {
  const { make, made } = poolFactory();
  const sql = requestScopedSql(make);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let running: Promise<unknown> | undefined;
  await withDbScope(async () => {
    running = sql.transaction!(async () => {
      await sql.query("first");
      await gate; // the request returns here
      await sql.query("second");
    });
    await settle();
  });
  release();
  await running;
  await settle();
  assert.equal(made.length, 1, "no stray pool for the late query");
  assert.deepEqual(made[0].log, [
    "tx: BEGIN",
    "tx: SET LOCAL idle_in_transaction_session_timeout = '30s'",
    "tx: first",
    "tx: second",
    "tx: COMMIT",
  ]);
  assert.equal(made[0].ended, true);
});
