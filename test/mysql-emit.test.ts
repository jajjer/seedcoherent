/** Tests for MySQL literal/param formatting, script emit, and the INSERT sink. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { MysqlSink, mysqlLiteral, toParam, toSqlMysql } from "../src/mysql-emit.js";
import type { Row, TableData } from "../src/generate.js";
import type { Connection } from "../src/types.js";
import { col, table } from "./helpers.js";

const textCol = col("c", { udtName: "varchar" });
const jsonCol = col("meta", { udtName: "json", dataType: "json" });

test("mysqlLiteral formats scalars, dates, blobs, and escapes strings", () => {
  assert.equal(mysqlLiteral(null, textCol), "NULL");
  assert.equal(mysqlLiteral(true, textCol), "1");
  assert.equal(mysqlLiteral(false, textCol), "0");
  assert.equal(mysqlLiteral(42, textCol), "42");
  assert.equal(mysqlLiteral(new Date("2025-01-02T03:04:05.678Z"), textCol), "'2025-01-02 03:04:05'");
  assert.equal(mysqlLiteral(Buffer.from([0xde, 0xad]), textCol), "X'dead'");
  // Backslash and single-quote are both escaped (MySQL treats \ as special).
  assert.equal(mysqlLiteral("a'b\\c", textCol), "'a''b\\\\c'");
  assert.equal(mysqlLiteral({ a: 1 }, jsonCol), `'${JSON.stringify({ a: 1 })}'`);
});

test("toParam converts booleans and serializes JSON, passes Date/Buffer through", () => {
  assert.equal(toParam(true, textCol), 1);
  assert.equal(toParam(false, textCol), 0);
  assert.equal(toParam(null, textCol), null);
  const d = new Date();
  assert.equal(toParam(d, textCol), d);
  const b = Buffer.from([1]);
  assert.equal(toParam(b, textCol), b);
  assert.equal(toParam({ a: 1 }, jsonCol), '{"a":1}');
  assert.equal(toParam("hi", textCol), "hi");
});

test("toSqlMysql wraps inserts with FK-check toggles and a transaction", () => {
  const t = table("users", { schema: "app", columns: [col("id", { udtName: "int" }), textCol] });
  const data: TableData[] = [
    { table: t, columns: t.columns, rows: [{ id: 1, c: "x" }, { id: 2, c: "y" }] },
  ];
  const sql = toSqlMysql(data);
  assert.match(sql, /^SET FOREIGN_KEY_CHECKS=0;\nSTART TRANSACTION;/);
  assert.match(sql, /INSERT INTO `users` \(`id`, `c`\) VALUES/);
  assert.match(sql, /\(1, 'x'\),\n {2}\(2, 'y'\);/);
  assert.match(sql, /COMMIT;\nSET FOREIGN_KEY_CHECKS=1;$/);
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
  const sink = new MysqlSink(conn, { ...opts, tables: data.map((d) => d.table) });
  for (const { table, rows, columns } of data) {
    await sink.begin(table, columns);
    await sink.write(rows);
    await sink.end();
  }
  await sink.finalize();
  return sink;
}

test("MysqlSink batches a multi-row INSERT inside a transaction", async () => {
  const t = table("users", { schema: "app", columns: [col("id", { udtName: "int" }), textCol] });
  const rows: Row[] = [{ id: 1, c: "a" }, { id: 2, c: "b" }];
  const conn = new RecordingConn();
  const sink = await runSink(conn, [{ table: t, columns: t.columns, rows }]);

  assert.equal(sink.inserted, 2);
  const sqls = conn.calls.map((c) => c.sql);
  assert.equal(sqls[0], "START TRANSACTION");
  assert.equal(sqls.at(-1), "COMMIT");
  const insert = conn.calls.find((c) => c.sql.startsWith("INSERT"))!;
  assert.equal(
    insert.sql,
    "INSERT INTO `users` (`id`, `c`) VALUES (?, ?), (?, ?)",
  );
  assert.deepEqual(insert.params, [1, "a", 2, "b"]);
});

test("MysqlSink truncates via reverse-order DELETE with FK checks off", async () => {
  const users = table("users", { schema: "app", columns: [col("id", { udtName: "int" })] });
  const orders = table("orders", { schema: "app", columns: [col("id", { udtName: "int" })] });
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
  // FK checks toggled around DELETEs, children (orders) cleared before parents.
  assert.deepEqual(sqls.slice(0, 5), [
    "START TRANSACTION",
    "SET FOREIGN_KEY_CHECKS=0",
    "DELETE FROM `orders`",
    "DELETE FROM `users`",
    "SET FOREIGN_KEY_CHECKS=1",
  ]);
});

test("MysqlSink rolls back when an insert fails", async () => {
  const t = table("users", { schema: "app", columns: [col("id", { udtName: "int" })] });
  const conn = new RecordingConn();
  const original = conn.query.bind(conn);
  conn.query = async (sql: string, params?: unknown[]) => {
    if (sql.startsWith("INSERT")) throw new Error("boom");
    return original(sql, params);
  };
  const sink = new MysqlSink(conn, { tables: [t] });
  await sink.begin(t, t.columns);
  await assert.rejects(() => sink.write([{ id: 1 }]), /boom/);
  assert.ok(conn.calls.some((c) => c.sql === "ROLLBACK"));
});
