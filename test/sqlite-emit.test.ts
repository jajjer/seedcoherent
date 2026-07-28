/** Tests for SQLite literal/param formatting, script emit, and the INSERT sink. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { SqliteSink, sqliteLiteral, toParam, toSqlSqlite } from "../src/sqlite-emit.js";
import type { Row, TableData } from "../src/generate.js";
import type { Connection } from "../src/types.js";
import { col, table } from "./helpers.js";

const textCol = col("c", { udtName: "varchar" });
const jsonCol = col("meta", { udtName: "json", dataType: "json" });

test("sqliteLiteral formats scalars, dates, blobs, and escapes strings", () => {
  assert.equal(sqliteLiteral(null, textCol), "NULL");
  assert.equal(sqliteLiteral(true, textCol), "1");
  assert.equal(sqliteLiteral(false, textCol), "0");
  assert.equal(sqliteLiteral(42, textCol), "42");
  assert.equal(sqliteLiteral(new Date("2025-01-02T03:04:05.678Z"), textCol), "'2025-01-02T03:04:05.678Z'");
  assert.equal(sqliteLiteral(Buffer.from([0xde, 0xad]), textCol), "X'dead'");
  // Only the single quote is special in SQLite; backslash passes through.
  assert.equal(sqliteLiteral("a'b\\c", textCol), "'a''b\\c'");
  assert.equal(sqliteLiteral({ a: 1 }, jsonCol), `'${JSON.stringify({ a: 1 })}'`);
});

test("toParam converts booleans/dates/JSON, passes Buffer through", () => {
  assert.equal(toParam(true, textCol), 1);
  assert.equal(toParam(false, textCol), 0);
  assert.equal(toParam(null, textCol), null);
  assert.equal(toParam(new Date("2025-01-02T03:04:05.678Z"), textCol), "2025-01-02T03:04:05.678Z");
  const b = Buffer.from([1]);
  assert.equal(toParam(b, textCol), b);
  assert.equal(toParam({ a: 1 }, jsonCol), '{"a":1}');
  assert.equal(toParam("hi", textCol), "hi");
});

test("toSqlSqlite disables FK checks and wraps inserts in a transaction", () => {
  const t = table("users", { schema: "main", columns: [col("id", { udtName: "INTEGER" }), textCol] });
  const data: TableData[] = [
    { table: t, columns: t.columns, rows: [{ id: 1, c: "x" }, { id: 2, c: "y" }] },
  ];
  const sql = toSqlSqlite(data);
  assert.match(sql, /^PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;/);
  assert.match(sql, /INSERT INTO "users" \("id", "c"\) VALUES/);
  assert.match(sql, /\(1, 'x'\),\n {2}\(2, 'y'\);/);
  assert.match(sql, /COMMIT;$/);
});

/** Records every query the sink issues so we can assert SQL + params. */
class RecordingConn implements Connection {
  calls: { sql: string; params?: unknown[] }[] = [];
  async query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
    this.calls.push({ sql, params });
    return { rows: [] as T[] };
  }
  async end() {}
}

async function runSink(conn: Connection, data: TableData[], opts = {}) {
  const sink = new SqliteSink(conn, { ...opts, tables: data.map((d) => d.table) });
  for (const { table, rows, columns } of data) {
    await sink.begin(table, columns);
    await sink.write(rows);
    await sink.end();
  }
  await sink.finalize();
  return sink;
}

test("SqliteSink batches a multi-row INSERT inside a deferred-FK transaction", async () => {
  const t = table("users", { schema: "main", columns: [col("id", { udtName: "INTEGER" }), textCol] });
  const rows: Row[] = [{ id: 1, c: "a" }, { id: 2, c: "b" }];
  const conn = new RecordingConn();
  const sink = await runSink(conn, [{ table: t, columns: t.columns, rows }]);

  assert.equal(sink.inserted, 2);
  const sqls = conn.calls.map((c) => c.sql);
  assert.equal(sqls[0], "PRAGMA defer_foreign_keys=ON");
  assert.equal(sqls[1], "BEGIN");
  assert.equal(sqls.at(-1), "COMMIT");
  const insert = conn.calls.find((c) => c.sql.startsWith("INSERT"))!;
  assert.equal(insert.sql, 'INSERT INTO "users" ("id", "c") VALUES (?, ?), (?, ?)');
  assert.deepEqual(insert.params, [1, "a", 2, "b"]);
});

test("SqliteSink truncates via reverse-order DELETE", async () => {
  const users = table("users", { schema: "main", columns: [col("id", { udtName: "INTEGER" })] });
  const orders = table("orders", { schema: "main", columns: [col("id", { udtName: "INTEGER" })] });
  const conn = new RecordingConn();
  await runSink(
    conn,
    [
      { table: users, columns: users.columns, rows: [{ id: 1 }] },
      { table: orders, columns: orders.columns, rows: [{ id: 1 }] },
    ],
    { truncate: true },
  );
  const sqls = conn.calls.map((c) => c.sql);
  // Children (orders) cleared before parents (users).
  assert.deepEqual(sqls.slice(0, 4), [
    "PRAGMA defer_foreign_keys=ON",
    "BEGIN",
    "DELETE FROM \"orders\"",
    "DELETE FROM \"users\"",
  ]);
});

test("SqliteSink caps rows per statement to respect the bind-param limit", async () => {
  // 5 columns * 200 rows would be 1000 binds; the sink must split the statement.
  const cols = ["a", "b", "c", "d", "e"].map((n) => col(n, { udtName: "INTEGER" }));
  const t = table("wide", { schema: "main", columns: cols });
  const rows: Row[] = Array.from({ length: 200 }, (_, i) => ({ a: i, b: i, c: i, d: i, e: i }));
  const conn = new RecordingConn();
  const sink = await runSink(conn, [{ table: t, columns: cols, rows }]);

  assert.equal(sink.inserted, 200);
  const inserts = conn.calls.filter((c) => c.sql.startsWith("INSERT"));
  assert.ok(inserts.length > 1, "expected the wide insert to be split");
  for (const ins of inserts) assert.ok((ins.params?.length ?? 0) <= 900);
});

test("SqliteSink rolls back when an insert fails", async () => {
  const t = table("users", { schema: "main", columns: [col("id", { udtName: "INTEGER" })] });
  const conn = new RecordingConn();
  const original = conn.query.bind(conn);
  conn.query = async (sql: string, params?: unknown[]) => {
    if (sql.startsWith("INSERT")) throw new Error("boom");
    return original(sql, params);
  };
  const sink = new SqliteSink(conn, { tables: [t] });
  await sink.begin(t, t.columns);
  await assert.rejects(() => sink.write([{ id: 1 }]), /boom/);
  assert.ok(conn.calls.some((c) => c.sql === "ROLLBACK"));
});
