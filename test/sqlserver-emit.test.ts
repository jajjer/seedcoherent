/** Tests for SQL Server literal/param formatting, script emit, and the INSERT sink. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MssqlSink,
  mssqlLiteral,
  toParam,
  toSqlMssql,
} from "../src/sqlserver-emit.js";
import type { Row, TableData } from "../src/generate.js";
import type { Connection } from "../src/types.js";
import { col, table } from "./helpers.js";

const textCol = col("c", { udtName: "varchar" });
const idCol = col("id", { udtName: "int4", isIdentity: true });
const plainId = col("id", { udtName: "int4" });

test("mssqlLiteral formats scalars, dates, binary, and uses N'' for strings", () => {
  assert.equal(mssqlLiteral(null, textCol), "NULL");
  assert.equal(mssqlLiteral(true, textCol), "1");
  assert.equal(mssqlLiteral(false, textCol), "0");
  assert.equal(mssqlLiteral(42, textCol), "42");
  assert.equal(
    mssqlLiteral(new Date("2025-01-02T03:04:05.678Z"), textCol),
    "'2025-01-02 03:04:05.678'",
  );
  assert.equal(mssqlLiteral(Buffer.from([0xde, 0xad]), textCol), "0xdead");
  assert.equal(mssqlLiteral("a'b", textCol), "N'a''b'");
  assert.equal(
    mssqlLiteral({ a: 1 }, textCol),
    `N'${JSON.stringify({ a: 1 })}'`,
  );
});

test("toParam passes scalars/Date/Buffer through, serializes JSON", () => {
  assert.equal(toParam(null, textCol), null);
  const d = new Date();
  assert.equal(toParam(d, textCol), d);
  const b = Buffer.from([1]);
  assert.equal(toParam(b, textCol), b);
  assert.equal(toParam({ a: 1 }, textCol), '{"a":1}');
  assert.equal(toParam("hi", textCol), "hi");
  assert.equal(toParam(7, textCol), 7);
});

test("toSqlMssql wraps inserts with FK toggles, identity_insert, and a transaction", () => {
  const t = table("users", { schema: "app", columns: [idCol, textCol] });
  const data: TableData[] = [
    {
      table: t,
      columns: t.columns,
      rows: [
        { id: 1, c: "x" },
        { id: 2, c: "y" },
      ],
    },
  ];
  const sql = toSqlMssql(data);
  assert.match(sql, /^SET XACT_ABORT ON;\nBEGIN TRANSACTION;/);
  assert.match(sql, /ALTER TABLE \[app\]\.\[users\] NOCHECK CONSTRAINT ALL;/);
  assert.match(sql, /SET IDENTITY_INSERT \[app\]\.\[users\] ON;/);
  assert.match(sql, /INSERT INTO \[app\]\.\[users\] \(\[id\], \[c\]\) VALUES/);
  assert.match(sql, /\(1, N'x'\),\n {2}\(2, N'y'\);/);
  assert.match(sql, /SET IDENTITY_INSERT \[app\]\.\[users\] OFF;/);
  assert.match(
    sql,
    /ALTER TABLE \[app\]\.\[users\] WITH CHECK CHECK CONSTRAINT ALL;/,
  );
  assert.match(sql, /COMMIT;$/);
});

test("toSqlMssql without identity columns omits IDENTITY_INSERT", () => {
  const t = table("tags", { columns: [plainId, textCol] });
  const sql = toSqlMssql([
    { table: t, columns: t.columns, rows: [{ id: 1, c: "x" }] },
  ]);
  assert.doesNotMatch(sql, /IDENTITY_INSERT/);
  assert.match(sql, /INSERT INTO \[public\]\.\[tags\]/);
});

test("toSqlMssql onConflict:skip emits an insert-only MERGE", () => {
  const t = table("users", {
    columns: [plainId, textCol],
    primaryKey: ["id"],
  });
  const sql = toSqlMssql(
    [{ table: t, columns: t.columns, rows: [{ id: 1, c: "x" }] }],
    { onConflict: "skip" },
  );
  assert.match(sql, /MERGE INTO \[public\]\.\[users\] AS tgt/);
  assert.match(sql, /ON tgt\.\[id\] = src\.\[id\]/);
  assert.match(sql, /WHEN NOT MATCHED THEN INSERT \(\[id\], \[c\]\)/);
  assert.doesNotMatch(sql, /WHEN MATCHED/);
});

test("toSqlMssql onConflict:update merges with an UPDATE of non-key columns", () => {
  const t = table("users", {
    columns: [plainId, textCol],
    primaryKey: ["id"],
  });
  const sql = toSqlMssql(
    [{ table: t, columns: t.columns, rows: [{ id: 1, c: "x" }] }],
    { onConflict: "update" },
  );
  // The UPDATE SET lists only the non-key column — the PK is excluded.
  assert.match(sql, /UPDATE SET \[c\] = src\.\[c\]\n/);
  assert.doesNotMatch(sql, /UPDATE SET [^\n]*\[id\]/);
  assert.match(sql, /WHEN NOT MATCHED THEN INSERT/);
});

test("toSqlMssql onConflict with no key target falls back to a plain INSERT", () => {
  const t = table("log", { columns: [textCol] });
  const sql = toSqlMssql(
    [{ table: t, columns: t.columns, rows: [{ c: "x" }] }],
    {
      onConflict: "skip",
    },
  );
  assert.doesNotMatch(sql, /MERGE/);
  assert.match(sql, /INSERT INTO \[public\]\.\[log\] \(\[c\]\) VALUES/);
});

/** Records every query the sink issues so we can assert SQL + params. */
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

async function runSink(conn: Connection, data: TableData[], opts = {}) {
  const sink = new MssqlSink(conn, {
    ...opts,
    tables: data.map((d) => d.table),
  });
  for (const { table, rows, columns } of data) {
    await sink.begin(table, columns);
    await sink.write(rows);
    await sink.end();
  }
  await sink.finalize();
  return sink;
}

test("MssqlSink batches a multi-row @pN INSERT inside a transaction", async () => {
  const t = table("tags", { schema: "app", columns: [plainId, textCol] });
  const rows: Row[] = [
    { id: 1, c: "a" },
    { id: 2, c: "b" },
  ];
  const conn = new RecordingConn();
  const sink = await runSink(conn, [{ table: t, columns: t.columns, rows }]);

  assert.equal(sink.inserted, 2);
  const sqls = conn.calls.map((c) => c.sql);
  assert.equal(sqls[0], "SET XACT_ABORT ON");
  assert.equal(sqls[1], "BEGIN TRANSACTION");
  assert.equal(sqls.at(-1), "COMMIT");
  const insert = conn.calls.find((c) => c.sql.startsWith("INSERT"))!;
  assert.equal(
    insert.sql,
    "INSERT INTO [app].[tags] ([id], [c]) VALUES (@p1, @p2), (@p3, @p4)",
  );
  assert.deepEqual(insert.params, [1, "a", 2, "b"]);
});

test("MssqlSink sets IDENTITY_INSERT in the insert batch and reseeds on finalize", async () => {
  const t = table("users", { schema: "app", columns: [idCol, textCol] });
  const conn = new RecordingConn();
  await runSink(conn, [
    { table: t, columns: t.columns, rows: [{ id: 1, c: "a" }] },
  ]);
  const sqls = conn.calls.map((c) => c.sql);
  // IDENTITY_INSERT must share the INSERT's batch — a standalone SET doesn't
  // carry over to a later request on the same mssql transaction.
  const insert = conn.calls.find((c) => c.sql.includes("INSERT INTO"))!;
  assert.ok(
    insert.sql.startsWith("SET IDENTITY_INSERT [app].[users] ON; INSERT INTO "),
    `expected IDENTITY_INSERT prefix on the insert batch, got: ${insert.sql}`,
  );
  // No standalone IDENTITY_INSERT toggles are issued as separate statements.
  assert.ok(!sqls.includes("SET IDENTITY_INSERT [app].[users] ON"));
  assert.ok(!sqls.includes("SET IDENTITY_INSERT [app].[users] OFF"));
  assert.ok(
    sqls.includes("DBCC CHECKIDENT ('app.users', RESEED)"),
    "reseeds identity so later app inserts don't collide",
  );
});

test("MssqlSink truncates via NOCHECK + reverse-order DELETE + re-check", async () => {
  const users = table("users", { schema: "app", columns: [plainId] });
  const orders = table("orders", { schema: "app", columns: [plainId] });
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
  assert.deepEqual(sqls.slice(0, 8), [
    "SET XACT_ABORT ON",
    "BEGIN TRANSACTION",
    "ALTER TABLE [app].[users] NOCHECK CONSTRAINT ALL",
    "ALTER TABLE [app].[orders] NOCHECK CONSTRAINT ALL",
    "DELETE FROM [app].[orders]",
    "DELETE FROM [app].[users]",
    "ALTER TABLE [app].[users] WITH CHECK CHECK CONSTRAINT ALL",
    "ALTER TABLE [app].[orders] WITH CHECK CHECK CONSTRAINT ALL",
  ]);
});

test("MssqlSink rolls back when an insert fails", async () => {
  const t = table("users", { schema: "app", columns: [plainId] });
  const conn = new RecordingConn();
  const original = conn.query.bind(conn);
  conn.query = async (sql: string, params?: unknown[]) => {
    if (sql.startsWith("INSERT")) throw new Error("boom");
    return original(sql, params);
  };
  const sink = new MssqlSink(conn, { tables: [t] });
  await sink.begin(t, t.columns);
  await assert.rejects(() => sink.write([{ id: 1 }]), /boom/);
  assert.ok(conn.calls.some((c) => c.sql === "ROLLBACK"));
});
