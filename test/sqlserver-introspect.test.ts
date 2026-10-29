/** Tests for SQL Server type categorization, CHECK normalization, and introspection. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  categorizeMssql,
  introspectMssql,
  normalizeMssqlCheck,
} from "../src/sqlserver-introspect.js";
import { parseChecks } from "../src/checks.js";
import type { Connection } from "../src/types.js";

test("integer family", () => {
  for (const t of ["tinyint", "smallint", "int", "bigint"])
    assert.equal(categorizeMssql(t), "integer");
});

test("decimal family includes money and floats", () => {
  for (const t of [
    "decimal",
    "numeric",
    "money",
    "smallmoney",
    "float",
    "real",
  ])
    assert.equal(categorizeMssql(t), "decimal");
});

test("bit is boolean, uniqueidentifier is uuid", () => {
  assert.equal(categorizeMssql("bit"), "boolean");
  assert.equal(categorizeMssql("uniqueidentifier"), "uuid");
});

test("date/time families are distinguished", () => {
  assert.equal(categorizeMssql("date"), "date");
  assert.equal(categorizeMssql("time"), "time");
  for (const t of ["datetime", "datetime2", "smalldatetime", "datetimeoffset"])
    assert.equal(categorizeMssql(t), "timestamp");
});

test("text and binary families; rowversion stays unsupported", () => {
  for (const t of [
    "char",
    "varchar",
    "nchar",
    "nvarchar",
    "text",
    "ntext",
    "xml",
    "sysname",
  ])
    assert.equal(categorizeMssql(t), "text");
  for (const t of ["binary", "varbinary", "image"])
    assert.equal(categorizeMssql(t), "bytea");
  assert.equal(categorizeMssql("rowversion"), "unsupported");
  assert.equal(categorizeMssql("geometry"), "unsupported");
});

test("normalizeMssqlCheck rewrites brackets, strips N'' introducers, rewrites IN-lists", () => {
  assert.equal(normalizeMssqlCheck("([price]>(0))"), '("price">(0))');
  const norm = normalizeMssqlCheck("([status] IN (N'active',N'closed'))");
  assert.equal(norm, `("status" = ANY (ARRAY['active','closed']))`);
  const bounds = parseChecks([{ expr: norm }]).get("status");
  assert.deepEqual(bounds?.in, ["active", "closed"]);
});

/** A Connection stub that answers each sys.* catalog query from fixtures. */
function mockConn(fixtures: {
  tables: unknown[];
  columns: unknown[];
  keys: unknown[];
  fks: unknown[];
  checks?: unknown[];
}): Connection {
  return {
    async query<T = Record<string, unknown>>(
      sql: string,
    ): Promise<{ rows: T[] }> {
      let rows: unknown[];
      if (sql.includes("sys.check_constraints")) rows = fixtures.checks ?? [];
      else if (sql.includes("sys.foreign_keys")) rows = fixtures.fks;
      else if (sql.includes("sys.key_constraints")) rows = fixtures.keys;
      else if (sql.includes("TYPE_NAME(")) rows = fixtures.columns;
      else rows = fixtures.tables;
      return { rows: rows as T[] };
    },
    async end() {},
  };
}

function column(over: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: "dbo",
    table_name: "users",
    column_name: "x",
    ordinal: 1,
    data_type: "int",
    max_length: null,
    precision: null,
    scale: null,
    is_nullable: 0,
    is_identity: 0,
    is_computed: 0,
    has_default: 0,
    default_expr: null,
    ...over,
  };
}

test("introspectMssql builds tables, keys, FKs, checks, and converts n-char length", async () => {
  const conn = mockConn({
    tables: [
      { schema: "dbo", table_name: "users" },
      { schema: "dbo", table_name: "orders" },
    ],
    columns: [
      column({
        table_name: "users",
        column_name: "id",
        data_type: "int",
        is_identity: 1,
      }),
      column({
        table_name: "users",
        column_name: "email",
        ordinal: 2,
        data_type: "nvarchar",
        max_length: 510, // bytes → 255 characters
      }),
      column({
        table_name: "users",
        column_name: "created_at",
        ordinal: 3,
        data_type: "datetime2",
        is_nullable: 1,
      }),
      column({
        table_name: "users",
        column_name: "rv",
        ordinal: 4,
        data_type: "rowversion",
      }),
      column({
        table_name: "orders",
        column_name: "id",
        data_type: "int",
        is_identity: 1,
      }),
      column({
        table_name: "orders",
        column_name: "user_id",
        ordinal: 2,
        data_type: "int",
      }),
      column({
        table_name: "orders",
        column_name: "total",
        ordinal: 3,
        data_type: "decimal",
        precision: 10,
        scale: 2,
      }),
    ],
    keys: [
      {
        schema: "dbo",
        table_name: "users",
        cname: "PK_users",
        ctype: "PRIMARY KEY",
        column_name: "id",
      },
      {
        schema: "dbo",
        table_name: "users",
        cname: "UQ_email",
        ctype: "UNIQUE",
        column_name: "email",
      },
      {
        schema: "dbo",
        table_name: "orders",
        cname: "PK_orders",
        ctype: "PRIMARY KEY",
        column_name: "id",
      },
    ],
    fks: [
      {
        schema: "dbo",
        table_name: "orders",
        cname: "FK_user",
        column_name: "user_id",
        ref_schema: "dbo",
        ref_table: "users",
        ref_column: "id",
      },
    ],
    checks: [
      {
        schema: "dbo",
        table_name: "orders",
        check_clause: "([total]>=(0))",
      },
    ],
  });

  const schema = await introspectMssql(conn, ["dbo"]);
  assert.deepEqual([...schema.tables.keys()].sort(), [
    "dbo.orders",
    "dbo.users",
  ]);

  const users = schema.tables.get("dbo.users")!;
  assert.deepEqual(users.primaryKey, ["id"]);
  assert.deepEqual(users.uniques, [["email"]]);
  assert.equal(users.columns.find((c) => c.name === "id")!.isIdentity, true);
  assert.equal(users.columns.find((c) => c.name === "email")!.maxLength, 255);
  assert.equal(
    users.columns.find((c) => c.name === "created_at")!.dataType,
    "timestamp",
  );
  // rowversion is auto-maintained → treated as DB-assigned so it's left out of inserts.
  assert.equal(users.columns.find((c) => c.name === "rv")!.isGenerated, true);

  const orders = schema.tables.get("dbo.orders")!;
  assert.deepEqual(orders.foreignKeys, [
    { columns: ["user_id"], refTable: "dbo.users", refColumns: ["id"] },
  ]);
  const total = orders.columns.find((c) => c.name === "total")!;
  assert.equal(total.dataType, "decimal");
  assert.equal(total.numericScale, 2);
  assert.deepEqual(orders.checks, [{ expr: '("total">=(0))' }]);
});

test("introspectMssql de-duplicates a unique constraint also backed by an index", async () => {
  const conn = mockConn({
    tables: [{ schema: "dbo", table_name: "t" }],
    columns: [
      column({ table_name: "t", column_name: "code", data_type: "int" }),
    ],
    keys: [
      // Same column set reported once as a UNIQUE constraint and once as its index.
      {
        schema: "dbo",
        table_name: "t",
        cname: "UQ_code",
        ctype: "UNIQUE",
        column_name: "code",
      },
      {
        schema: "dbo",
        table_name: "t",
        cname: "UX_code",
        ctype: "UNIQUE",
        column_name: "code",
      },
    ],
    fks: [],
  });
  const schema = await introspectMssql(conn, ["dbo"]);
  assert.deepEqual(schema.tables.get("dbo.t")!.uniques, [["code"]]);
});
