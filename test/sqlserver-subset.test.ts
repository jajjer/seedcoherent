/** Tests that the SQL Server subset fetcher builds the right `@pN`-parameterized SQL. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { MssqlRowFetcher } from "../src/sqlserver-subset.js";
import type { Connection } from "../src/types.js";
import { col, table } from "./helpers.js";

class RecordingConn implements Connection {
  calls: { sql: string; params?: unknown[] }[] = [];
  async query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }> {
    this.calls.push({ sql, params });
    return { rows: [] as T[] };
  }
  async end() {}
}

const users = table("users", {
  schema: "dbo",
  columns: [col("id", { udtName: "int" }), col("email")],
  primaryKey: ["id"],
});

test("fetchRoots uses TOP (n) with a bound limit, ordered by PK", async () => {
  const conn = new RecordingConn();
  await new MssqlRowFetcher(conn).fetchRoots(users, 25);
  assert.equal(
    conn.calls[0].sql,
    "SELECT TOP (@p1) * FROM [dbo].[users] ORDER BY [id]",
  );
  assert.deepEqual(conn.calls[0].params, [25]);
});

test("fetchRoots splices a WHERE predicate before ORDER BY", async () => {
  const conn = new RecordingConn();
  await new MssqlRowFetcher(conn).fetchRoots(users, 25, "total > 100");
  assert.equal(
    conn.calls[0].sql,
    "SELECT TOP (@p1) * FROM [dbo].[users] WHERE total > 100 ORDER BY [id]",
  );
  assert.deepEqual(conn.calls[0].params, [25]);
});

test("fetchByKeys uses IN (@p...) for a single-column key", async () => {
  const conn = new RecordingConn();
  await new MssqlRowFetcher(conn).fetchByKeys(users, ["id"], [[1], [2], [3]]);
  assert.equal(
    conn.calls[0].sql,
    "SELECT * FROM [dbo].[users] WHERE [id] IN (@p1, @p2, @p3)",
  );
  assert.deepEqual(conn.calls[0].params, [1, 2, 3]);
});

test("fetchByKeys ORs AND-groups for composite keys (no tuple IN in SQL Server)", async () => {
  const membership = table("membership", {
    schema: "dbo",
    columns: [
      col("org_id", { udtName: "int" }),
      col("user_id", { udtName: "int" }),
    ],
    primaryKey: ["org_id", "user_id"],
  });
  const conn = new RecordingConn();
  await new MssqlRowFetcher(conn).fetchByKeys(
    membership,
    ["org_id", "user_id"],
    [
      [1, 10],
      [2, 20],
    ],
  );
  assert.equal(
    conn.calls[0].sql,
    "SELECT * FROM [dbo].[membership] WHERE ([org_id] = @p1 AND [user_id] = @p2) OR ([org_id] = @p3 AND [user_id] = @p4)",
  );
  assert.deepEqual(conn.calls[0].params, [1, 10, 2, 20]);
});

test("fetchByKeys returns nothing for an empty key set without querying", async () => {
  const conn = new RecordingConn();
  const rows = await new MssqlRowFetcher(conn).fetchByKeys(users, ["id"], []);
  assert.deepEqual(rows, []);
  assert.equal(conn.calls.length, 0);
});

test("maxInt reads MAX(col) for the append-mode sequence continuation", async () => {
  const conn = new RecordingConn();
  await new MssqlRowFetcher(conn).maxInt(users, "id");
  assert.equal(conn.calls[0].sql, "SELECT MAX([id]) AS m FROM [dbo].[users]");
});
