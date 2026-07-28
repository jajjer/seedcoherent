/** Tests for MySQL type categorization, enum/check parsing, and introspection. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  categorizeMysql,
  introspectMysql,
  normalizeMysqlCheck,
  parseEnumValues,
} from "../src/mysql-introspect.js";
import type { Connection } from "../src/types.js";

const cat = (dt: string, ct = dt, en: string[] | null = null) => categorizeMysql(dt, ct, en);

test("tinyint(1) is boolean, wider tinyint is integer", () => {
  assert.equal(cat("tinyint", "tinyint(1)"), "boolean");
  assert.equal(cat("tinyint", "tinyint(4)"), "integer");
  assert.equal(cat("tinyint", "tinyint"), "integer");
});

test("integer family", () => {
  for (const t of ["smallint", "mediumint", "int", "integer", "bigint", "bit", "year"]) {
    assert.equal(cat(t), "integer");
  }
});

test("decimal family", () => {
  for (const t of ["decimal", "numeric", "fixed", "float", "double", "real"]) {
    assert.equal(cat(t), "decimal");
  }
});

test("date/time families are distinguished", () => {
  assert.equal(cat("date"), "date");
  assert.equal(cat("time"), "time");
  assert.equal(cat("datetime"), "timestamp");
  assert.equal(cat("timestamp"), "timestamp");
});

test("binary/text/json families", () => {
  for (const t of ["binary", "varbinary", "blob", "tinyblob", "mediumblob", "longblob"]) {
    assert.equal(cat(t), "bytea");
  }
  for (const t of ["char", "varchar", "text", "tinytext", "mediumtext", "longtext", "set"]) {
    assert.equal(cat(t), "text");
  }
  assert.equal(cat("json"), "json");
  assert.equal(cat("geometry"), "text"); // unknown -> text
});

test("enum labels win over the base type", () => {
  assert.equal(cat("enum", "enum('a','b')", ["a", "b"]), "enum");
});

test("parseEnumValues extracts labels, handles doubled quotes, ignores non-enums", () => {
  assert.deepEqual(parseEnumValues("enum('active','inactive','pending')"), [
    "active",
    "inactive",
    "pending",
  ]);
  assert.deepEqual(parseEnumValues("enum('a''b','c')"), ["a'b", "c"]);
  assert.deepEqual(parseEnumValues("set('x','y')"), ["x", "y"]);
  assert.equal(parseEnumValues("varchar(255)"), null);
});

test("normalizeMysqlCheck rewrites backticks and strips charset introducers", () => {
  assert.equal(normalizeMysqlCheck("(`price` > 0)"), '("price" > 0)');
  assert.equal(
    normalizeMysqlCheck("(`status` in (_utf8mb4'a',_utf8mb4'b'))"),
    `("status" in ('a','b'))`,
  );
});

/** A Connection stub that answers each information_schema query from fixtures. */
function mockConn(fixtures: {
  tables: any[];
  columns: any[];
  constraints: any[];
  checks?: any[];
}): Connection {
  return {
    async query<T = any>(sql: string): Promise<{ rows: T[] }> {
      let rows: any[] = [];
      if (sql.includes("information_schema.TABLES")) rows = fixtures.tables;
      else if (sql.includes("information_schema.COLUMNS")) rows = fixtures.columns;
      else if (sql.includes("information_schema.CHECK_CONSTRAINTS")) rows = fixtures.checks ?? [];
      else if (sql.includes("TABLE_CONSTRAINTS")) rows = fixtures.constraints;
      return { rows: rows as T[] };
    },
    async end() {},
  };
}

function column(over: Record<string, any>): any {
  return {
    schema: "app",
    table_name: "users",
    column_name: "x",
    ordinal: 1,
    data_type: "int",
    column_type: "int",
    is_nullable: "NO",
    default_expr: null,
    extra: "",
    max_length: null,
    numeric_precision: null,
    numeric_scale: null,
    ...over,
  };
}

test("introspectMysql builds tables, keys, enums, FKs, and checks", async () => {
  const conn = mockConn({
    // user_view is intentionally absent: it's a view, so it's not a BASE TABLE.
    tables: [
      { schema: "app", table_name: "users" },
      { schema: "app", table_name: "orders" },
    ],
    columns: [
      column({ table_name: "users", column_name: "id", extra: "auto_increment" }),
      column({
        table_name: "users",
        column_name: "email",
        ordinal: 2,
        data_type: "varchar",
        column_type: "varchar(255)",
        max_length: 255,
      }),
      column({
        table_name: "users",
        column_name: "status",
        ordinal: 3,
        data_type: "enum",
        column_type: "enum('active','inactive')",
        is_nullable: "YES",
      }),
      column({ table_name: "orders", column_name: "id", extra: "auto_increment" }),
      column({ table_name: "orders", column_name: "user_id", ordinal: 2 }),
      column({
        table_name: "orders",
        column_name: "total",
        ordinal: 3,
        data_type: "decimal",
        column_type: "decimal(10,2)",
        numeric_precision: 10,
        numeric_scale: 2,
      }),
      // A column on a view: must be dropped because user_view isn't a BASE TABLE.
      column({ table_name: "user_view", column_name: "id" }),
    ],
    constraints: [
      { schema: "app", table_name: "users", ctype: "PRIMARY KEY", cname: "PRIMARY", column_name: "id", ref_schema: null, ref_table: null, ref_column: null },
      { schema: "app", table_name: "users", ctype: "UNIQUE", cname: "email_uq", column_name: "email", ref_schema: null, ref_table: null, ref_column: null },
      { schema: "app", table_name: "orders", ctype: "PRIMARY KEY", cname: "PRIMARY", column_name: "id", ref_schema: null, ref_table: null, ref_column: null },
      { schema: "app", table_name: "orders", ctype: "FOREIGN KEY", cname: "fk_user", column_name: "user_id", ref_schema: "app", ref_table: "users", ref_column: "id" },
    ],
    checks: [{ schema: "app", table_name: "orders", check_clause: "(`total` >= 0)" }],
  });

  const schema = await introspectMysql(conn, ["app"]);
  assert.deepEqual([...schema.tables.keys()].sort(), ["app.orders", "app.users"]);

  const users = schema.tables.get("app.users")!;
  assert.deepEqual(users.primaryKey, ["id"]);
  assert.deepEqual(users.uniques, [["email"]]);
  assert.equal(users.columns.find((c) => c.name === "id")!.isIdentity, true);
  const status = users.columns.find((c) => c.name === "status")!;
  assert.equal(status.dataType, "enum");
  assert.deepEqual(status.enumValues, ["active", "inactive"]);
  assert.equal(status.nullable, true);

  const orders = schema.tables.get("app.orders")!;
  assert.deepEqual(orders.foreignKeys, [
    { columns: ["user_id"], refTable: "app.users", refColumns: ["id"] },
  ]);
  const total = orders.columns.find((c) => c.name === "total")!;
  assert.equal(total.dataType, "decimal");
  assert.equal(total.numericScale, 2);
  assert.deepEqual(orders.checks, [{ expr: '("total" >= 0)' }]);
});

test("introspectMysql tolerates servers without CHECK_CONSTRAINTS", async () => {
  const conn: Connection = {
    async query<T = any>(sql: string): Promise<{ rows: T[] }> {
      if (sql.includes("CHECK_CONSTRAINTS")) throw new Error("Unknown table");
      if (sql.includes("information_schema.TABLES"))
        return { rows: [{ schema: "app", table_name: "t" }] as T[] };
      if (sql.includes("information_schema.COLUMNS"))
        return { rows: [column({ table_name: "t", column_name: "id" })] as T[] };
      return { rows: [] as T[] };
    },
    async end() {},
  };
  const schema = await introspectMysql(conn, ["app"]);
  assert.equal(schema.tables.get("app.t")!.checks.length, 0);
});
