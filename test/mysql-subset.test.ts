/** Tests that the MySQL subset fetcher builds the right `?`-parameterized SQL. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { MysqlRowFetcher } from "../src/mysql-subset.js";
import type { Connection } from "../src/types.js";
import { col, table } from "./helpers.js";

class RecordingConn implements Connection {
  calls: { sql: string; params?: unknown[] }[] = [];
  async query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
    this.calls.push({ sql, params });
    return { rows: [] as T[] };
  }
  async end() {}
}

const users = table("users", {
  schema: "app",
  columns: [col("id", { udtName: "int" }), col("email")],
  primaryKey: ["id"],
});

test("fetchRoots orders by PK and binds the limit", async () => {
  const conn = new RecordingConn();
  await new MysqlRowFetcher(conn).fetchRoots(users, 25);
  assert.equal(conn.calls[0].sql, "SELECT * FROM `app`.`users` ORDER BY `id` LIMIT ?");
  assert.deepEqual(conn.calls[0].params, [25]);
});

test("fetchByKeys uses IN (?) for a single-column key", async () => {
  const conn = new RecordingConn();
  await new MysqlRowFetcher(conn).fetchByKeys(users, ["id"], [[1], [2], [3]]);
  assert.equal(conn.calls[0].sql, "SELECT * FROM `app`.`users` WHERE `id` IN (?)");
  assert.deepEqual(conn.calls[0].params, [[1, 2, 3]]);
});

test("fetchByKeys uses a row-constructor IN list for composite keys", async () => {
  const membership = table("membership", {
    schema: "app",
    columns: [col("org_id", { udtName: "int" }), col("user_id", { udtName: "int" })],
    primaryKey: ["org_id", "user_id"],
  });
  const conn = new RecordingConn();
  await new MysqlRowFetcher(conn).fetchByKeys(
    membership,
    ["org_id", "user_id"],
    [
      [1, 10],
      [2, 20],
    ],
  );
  assert.equal(
    conn.calls[0].sql,
    "SELECT * FROM `app`.`membership` WHERE (`org_id`, `user_id`) IN ((?, ?), (?, ?))",
  );
  assert.deepEqual(conn.calls[0].params, [1, 10, 2, 20]);
});

test("fetchByKeys returns nothing for an empty key set without querying", async () => {
  const conn = new RecordingConn();
  const rows = await new MysqlRowFetcher(conn).fetchByKeys(users, ["id"], []);
  assert.deepEqual(rows, []);
  assert.equal(conn.calls.length, 0);
});
