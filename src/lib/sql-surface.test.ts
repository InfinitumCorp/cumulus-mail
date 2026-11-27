import assert from "node:assert/strict";
import { test } from "node:test";
import { poolSql, type PoolLike } from "./sql-surface.ts";
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
  assert.deepEqual(log, ["client-0: BEGIN", "client-0: delete from messages", "client-0: insert into messages", "client-0: COMMIT", "pool-1: select outside"]);
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
  assert.deepEqual(log, ["client-0: BEGIN", "client-0: inner", "client-0: fail", "client-0: ROLLBACK"]);
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
