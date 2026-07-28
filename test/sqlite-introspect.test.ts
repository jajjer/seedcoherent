/** Tests for SQLite type categorization, CHECK extraction/rewrite, and introspection. */

import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import {
  categorizeSqlite,
  extractChecks,
  introspectSqlite,
  normalizeSqliteCheck,
} from "../src/sqlite-introspect.js";
import type { Connection } from "../src/types.js";

/** Wrap an in-memory better-sqlite3 handle as our async Connection. */
function memConn(ddl: string): Connection {
  const db = new Database(":memory:");
  db.exec(ddl);
  return {
    async query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
      const stmt = db.prepare(sql);
      const args = (params ?? []) as unknown[];
      if (stmt.reader) return { rows: stmt.all(...args) as T[] };
      stmt.run(...args);
      return { rows: [] };
    },
    async end() {
      db.close();
    },
  };
}

test("categorizeSqlite honors semantic types before affinity", () => {
  assert.equal(categorizeSqlite("BOOLEAN"), "boolean");
  assert.equal(categorizeSqlite("DATETIME"), "timestamp");
  assert.equal(categorizeSqlite("TIMESTAMP"), "timestamp");
  assert.equal(categorizeSqlite("DATE"), "date");
  assert.equal(categorizeSqlite("TIME"), "time");
  assert.equal(categorizeSqlite("JSON"), "json");
  assert.equal(categorizeSqlite("UUID"), "uuid");
});

test("categorizeSqlite falls back to SQLite type affinity", () => {
  for (const t of ["INTEGER", "INT", "BIGINT", "TINYINT"]) assert.equal(categorizeSqlite(t), "integer");
  for (const t of ["TEXT", "VARCHAR(255)", "CHARACTER(10)", "CLOB", "NVARCHAR"]) {
    assert.equal(categorizeSqlite(t), "text");
  }
  for (const t of ["", "BLOB"]) assert.equal(categorizeSqlite(t), "bytea");
  for (const t of ["REAL", "DOUBLE", "FLOAT"]) assert.equal(categorizeSqlite(t), "decimal");
  for (const t of ["DECIMAL(10,2)", "NUMERIC", "MONEY"]) assert.equal(categorizeSqlite(t), "decimal");
});

test("normalizeSqliteCheck requotes identifiers and rewrites IN-lists", () => {
  assert.equal(normalizeSqliteCheck("[price] > 0"), '"price" > 0');
  assert.equal(normalizeSqliteCheck("`price` > 0"), '"price" > 0');
  assert.equal(
    normalizeSqliteCheck("status IN ('active','inactive')"),
    "status = ANY (ARRAY['active','inactive'])",
  );
  // Nested inside a conjunction, both parts survive.
  assert.equal(
    normalizeSqliteCheck("qty > 0 AND kind IN ('a','b')"),
    "qty > 0 AND kind = ANY (ARRAY['a','b'])",
  );
  // A subquery IN is left alone (not a value list).
  assert.equal(
    normalizeSqliteCheck("id IN (SELECT id FROM other)"),
    "id IN (SELECT id FROM other)",
  );
});

test("extractChecks pulls column- and table-level CHECKs with balanced parens", () => {
  const ddl = `CREATE TABLE t (
    price INTEGER CHECK (price > 0),
    kind  TEXT CHECK (kind IN ('a','b')),
    CHECK (length(kind) <= 8)
  )`;
  assert.deepEqual(extractChecks(ddl), ["price > 0", "kind IN ('a','b')", "length(kind) <= 8"]);
});

test("introspectSqlite reads columns, keys, uniques, FKs, and checks", async () => {
  const conn = memConn(`
    CREATE TABLE users (
      id    INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name  TEXT NOT NULL,
      role  TEXT CHECK (role IN ('admin','member'))
    );
    CREATE TABLE orders (
      id      INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      total   DECIMAL(10,2) NOT NULL CHECK (total > 0)
    );
    CREATE VIEW active_users AS SELECT * FROM users;
  `);
  const schema = await introspectSqlite(conn, ["main"]);
  await conn.end();

  // The view is excluded; only base tables remain.
  assert.deepEqual([...schema.tables.keys()].sort(), ["main.orders", "main.users"]);

  const users = schema.tables.get("main.users")!;
  assert.deepEqual(users.primaryKey, ["id"]);
  assert.deepEqual(users.uniques, [["email"]]);
  const id = users.columns.find((c) => c.name === "id")!;
  assert.equal(id.isIdentity, true); // INTEGER PRIMARY KEY is the rowid alias
  assert.equal(id.dataType, "integer");
  const email = users.columns.find((c) => c.name === "email")!;
  assert.equal(email.nullable, false);
  // The role CHECK becomes an IN-membership bound the generator can honor.
  const roleCheck = users.checks.map((c) => c.expr);
  assert.ok(roleCheck.some((e) => /= ANY \(ARRAY\['admin','member'\]\)/.test(e)));

  const orders = schema.tables.get("main.orders")!;
  assert.deepEqual(orders.foreignKeys, [
    { columns: ["user_id"], refTable: "main.users", refColumns: ["id"] },
  ]);
  const total = orders.columns.find((c) => c.name === "total")!;
  assert.equal(total.dataType, "decimal");
  assert.equal(total.numericScale, 2);
  assert.equal(total.numericPrecision, 10);
});

test("introspectSqlite handles composite PK/FK and a null FK target (rowid)", async () => {
  const conn = memConn(`
    CREATE TABLE orders (id INTEGER PRIMARY KEY);
    CREATE TABLE order_items (
      order_id INTEGER NOT NULL,
      line_no  INTEGER NOT NULL,
      qty      INTEGER NOT NULL CHECK (qty >= 1 AND qty <= 100),
      PRIMARY KEY (order_id, line_no),
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );
  `);
  const schema = await introspectSqlite(conn, ["main"]);
  await conn.end();

  const items = schema.tables.get("main.order_items")!;
  assert.deepEqual(items.primaryKey, ["order_id", "line_no"]);
  // A composite PK is not a rowid alias, so it is not DB-assigned.
  assert.equal(items.columns.find((c) => c.name === "order_id")!.isIdentity, false);
  assert.deepEqual(items.foreignKeys, [
    { columns: ["order_id"], refTable: "main.orders", refColumns: ["id"] },
  ]);
});

test("introspectSqlite marks generated columns", async () => {
  const conn = memConn(`
    CREATE TABLE t (
      id    INTEGER PRIMARY KEY,
      price REAL NOT NULL,
      tax   REAL GENERATED ALWAYS AS (price * 0.1) STORED
    );
  `);
  const schema = await introspectSqlite(conn, ["main"]);
  await conn.end();
  const tax = schema.tables.get("main.t")!.columns.find((c) => c.name === "tax")!;
  assert.equal(tax.isGenerated, true);
});
