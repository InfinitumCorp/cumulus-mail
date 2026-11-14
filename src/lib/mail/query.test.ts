import assert from "node:assert/strict";
import { test } from "node:test";
import { withTransaction, type MailQuery } from "./query.ts";

/** A database double that records statements and can fail ROLLBACK. */
function recorder(options: { failRollback?: boolean } = {}) {
  const statements: string[] = [];
  const db: MailQuery = {
    query: async <T>(text: string) => {
      statements.push(text);
      if (text === "ROLLBACK" && options.failRollback) throw new Error("connection lost");
      return [] as T[];
    },
  };
  return { db, statements };
}

test("success: BEGIN, the work, COMMIT, and the work's value is returned", async () => {
  const { db, statements } = recorder();
  const value = await withTransaction(db, async () => {
    await db.query("insert 1");
    return 42;
  });
  assert.equal(value, 42);
  assert.deepEqual(statements, ["BEGIN", "insert 1", "COMMIT"]);
});

test("failure: ROLLBACK, and the original error reaches the caller", async () => {
  const { db, statements } = recorder();
  await assert.rejects(
    withTransaction(db, async () => {
      await db.query("insert 1");
      throw new Error("constraint violated");
    }),
    /constraint violated/,
  );
  assert.deepEqual(statements, ["BEGIN", "insert 1", "ROLLBACK"]);
});

test("a ROLLBACK that itself fails does not hide the original error", async () => {
  const { db, statements } = recorder({ failRollback: true });
  await assert.rejects(
    withTransaction(db, async () => {
      throw new Error("the real problem");
    }),
    /the real problem/,
  );
  assert.deepEqual(statements, ["BEGIN", "ROLLBACK"]);
});
