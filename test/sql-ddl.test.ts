/** Tests for the offline MySQL/SQLite DDL front-end (src/sql-ddl.ts). */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseChecks } from "../src/checks.js";
import { buildData } from "../src/generate.js";
import { topoSort } from "../src/graph.js";
import { loadSchemaFromSqlDdl, type SqlDialect } from "../src/sql-ddl.js";
import type { Schema, TableInfo } from "../src/types.js";

function tbl(s: Schema, key: string): TableInfo {
  const t = s.tables.get(key);
  assert.ok(t, `expected table ${key}; have ${[...s.tables.keys()].join(", ")}`);
  return t;
}

function column(t: TableInfo, name: string) {
  const c = t.columns.find((c) => c.name === name);
  assert.ok(c, `expected column ${name} on ${t.key}`);
  return c;
}

const load = (sql: string, dialect: SqlDialect) => loadSchemaFromSqlDdl(sql, dialect);

test("mysql: maps types, length/precision, nullability, and AUTO_INCREMENT identity", () => {
  const s = load(
    `
    CREATE TABLE \`users\` (
      \`id\`        INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`email\`     VARCHAR(255) NOT NULL,
      \`is_active\` TINYINT(1) NOT NULL DEFAULT 1,
      \`balance\`   DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`note\`      MEDIUMINT,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_email\` (\`email\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `,
    "mysql",
  );
  const users = tbl(s, "public.users");

  const id = column(users, "id");
  assert.equal(id.dataType, "integer");
  assert.equal(id.isIdentity, true, "AUTO_INCREMENT is DB-assigned");
  assert.ok(id.hasDefault);
  assert.deepEqual(users.primaryKey, ["id"]);
  assert.deepEqual(users.uniques, [["email"]]);

  const email = column(users, "email");
  assert.equal(email.dataType, "text");
  assert.equal(email.maxLength, 255);
  assert.equal(email.nullable, false);

  assert.equal(column(users, "is_active").dataType, "boolean");

  const balance = column(users, "balance");
  assert.equal(balance.dataType, "decimal");
  assert.equal(balance.numericPrecision, 10);
  assert.equal(balance.numericScale, 2);

  assert.equal(column(users, "created_at").dataType, "timestamp");
  assert.equal(column(users, "note").dataType, "integer");
  assert.equal(column(users, "note").nullable, true);
});

test("mysql: inline ENUM columns resolve to enum with their labels", () => {
  const s = load(
    `CREATE TABLE orders (
       id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
       status ENUM('pending', 'paid', 'shipped') NOT NULL DEFAULT 'pending'
     );`,
    "mysql",
  );
  const status = column(tbl(s, "public.orders"), "status");
  assert.equal(status.dataType, "enum");
  assert.deepEqual(status.enumValues, ["pending", "paid", "shipped"]);
});

test("mysql: BOOLEAN alias and SERIAL are recognized", () => {
  const s = load(
    `CREATE TABLE t (
       id SERIAL,
       flag BOOLEAN NOT NULL DEFAULT FALSE
     );`,
    "mysql",
  );
  const t = tbl(s, "public.t");
  const id = column(t, "id");
  assert.equal(id.dataType, "integer");
  assert.equal(id.isIdentity, true, "SERIAL is auto-incremented");
  assert.deepEqual(t.uniques, [["id"]], "SERIAL implies UNIQUE");
  assert.equal(column(t, "flag").dataType, "boolean");
});

test("mysql: inline, table-level (CONSTRAINT), and ALTER TABLE foreign keys", () => {
  const s = load(
    `
    CREATE TABLE users (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY);
    CREATE TABLE orders (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users (id)
    );
    CREATE TABLE items (
      order_id INT NOT NULL REFERENCES orders (id),
      product_id INT NOT NULL,
      PRIMARY KEY (order_id, product_id)
    );
    ALTER TABLE items ADD CONSTRAINT fk_prod FOREIGN KEY (product_id) REFERENCES products (id);
    CREATE TABLE products (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY);
    `,
    "mysql",
  );
  assert.deepEqual(tbl(s, "public.orders").foreignKeys, [
    { columns: ["user_id"], refTable: "public.users", refColumns: ["id"] },
  ]);
  const items = tbl(s, "public.items");
  assert.deepEqual(items.primaryKey, ["order_id", "product_id"]);
  assert.deepEqual(items.foreignKeys, [
    { columns: ["order_id"], refTable: "public.orders", refColumns: ["id"] },
    { columns: ["product_id"], refTable: "public.products", refColumns: ["id"] },
  ]);
});

test("mysql: CHECK constraints the check parser can read carry over", () => {
  const s = load(
    `CREATE TABLE line_items (
       price DECIMAL(10,2) NOT NULL CHECK (\`price\` > 0),
       qty   INT NOT NULL,
       CONSTRAINT chk_qty CHECK (qty >= 1 AND qty <= 100)
     );`,
    "mysql",
  );
  const bounds = parseChecks(tbl(s, "public.line_items").checks);
  assert.equal(bounds.get("price")?.min, 0);
  assert.equal(bounds.get("price")?.minExclusive, true);
  assert.equal(bounds.get("qty")?.min, 1);
  assert.equal(bounds.get("qty")?.max, 100);
});

test("mysql: USE sets the default schema for unqualified tables", () => {
  const s = load(
    `USE shop;
     CREATE TABLE widgets (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY);`,
    "mysql",
  );
  const t = tbl(s, "shop.widgets");
  assert.equal(t.schema, "shop");
});

test("sqlite: INTEGER PRIMARY KEY (and AUTOINCREMENT) is the rowid alias", () => {
  const s = load(
    `
    CREATE TABLE a (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE b (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE c (id INTEGER NOT NULL, PRIMARY KEY (id));
    `,
    "sqlite",
  );
  for (const key of ["main.a", "main.b", "main.c"]) {
    const id = column(tbl(s, key), "id");
    assert.equal(id.isIdentity, true, `${key}.id is the rowid alias`);
    assert.equal(id.hasDefault, true);
  }
});

test("sqlite: honors semantic type names and affinity", () => {
  const s = load(
    `CREATE TABLE t (
       id INTEGER PRIMARY KEY,
       created_at DATETIME NOT NULL,
       active BOOLEAN NOT NULL,
       meta JSON,
       ref UUID,
       title VARCHAR(200),
       score REAL,
       payload BLOB
     );`,
    "sqlite",
  );
  const t = tbl(s, "main.t");
  assert.equal(column(t, "created_at").dataType, "timestamp");
  assert.equal(column(t, "active").dataType, "boolean");
  assert.equal(column(t, "meta").dataType, "json");
  assert.equal(column(t, "ref").dataType, "uuid");
  assert.equal(column(t, "title").dataType, "text");
  assert.equal(column(t, "title").maxLength, 200);
  assert.equal(column(t, "score").dataType, "decimal");
  assert.equal(column(t, "payload").dataType, "bytea");
});

test("sqlite: CHECK (x IN (...)) enum idiom and range bounds carry over", () => {
  const s = load(
    `CREATE TABLE t (
       status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'banned')),
       age INTEGER CHECK (age >= 0 AND age < 150)
     );`,
    "sqlite",
  );
  const bounds = parseChecks(tbl(s, "main.t").checks);
  assert.deepEqual(bounds.get("status")?.in, ["active", "banned"]);
  assert.equal(bounds.get("age")?.min, 0);
  assert.equal(bounds.get("age")?.max, 150);
  assert.equal(bounds.get("age")?.maxExclusive, true);
});

test("sqlite: CREATE UNIQUE INDEX adds a unique constraint; plain INDEX does not", () => {
  const s = load(
    `
    CREATE TABLE t (id INTEGER PRIMARY KEY, email TEXT NOT NULL, name TEXT);
    CREATE UNIQUE INDEX uq_email ON t (email);
    CREATE INDEX ix_name ON t (name);
    `,
    "sqlite",
  );
  assert.deepEqual(tbl(s, "main.t").uniques, [["email"]]);
});

test("sqlite: bracket- and quote-delimited identifiers are unquoted", () => {
  const s = load(
    `CREATE TABLE [order] ("id" INTEGER PRIMARY KEY, [user id] TEXT NOT NULL);`,
    "sqlite",
  );
  const t = tbl(s, "main.order");
  assert.ok(column(t, "id"));
  assert.ok(column(t, "user id"));
});

test("skips statements it can't model without aborting the file", () => {
  const s = load(
    `
    PRAGMA foreign_keys = ON;
    CREATE INDEX ix ON keep (name);
    CREATE TRIGGER trg AFTER INSERT ON keep BEGIN SELECT 1; END;
    CREATE TABLE keep (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE VIEW v AS SELECT * FROM keep;
    `,
    "sqlite",
  );
  assert.ok(s.tables.has("main.keep"));
  assert.equal(tbl(s, "main.keep").columns.length, 2);
});

test("mysql end-to-end: generates coherent, constraint-valid rows", () => {
  const s = load(
    `
    CREATE TABLE users (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE
    );
    CREATE TABLE orders (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      status ENUM('pending','paid','shipped') NOT NULL DEFAULT 'pending',
      total DECIMAL(10,2) NOT NULL CHECK (total >= 0),
      CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users (id)
    );
    `,
    "mysql",
  );
  const { order, cyclic } = topoSort(s);
  const data = buildData(s, order, cyclic, { rows: { users: 5, orders: 20 }, seed: 7 });

  const userIds = new Set(data.find((d) => d.table.key === "public.users")!.rows.map((r) => r.id));
  assert.equal(userIds.size, 5);
  const orders = data.find((d) => d.table.key === "public.orders")!.rows;
  assert.equal(orders.length, 20);
  for (const o of orders) {
    assert.ok(userIds.has(o.user_id), "FK points at a real user");
    assert.ok(["pending", "paid", "shipped"].includes(o.status as string), "enum in range");
    assert.ok((o.total as number) >= 0, "CHECK bound honored");
  }
});

test("sqlite end-to-end: generates coherent, constraint-valid rows", () => {
  const s = load(
    `
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','banned'))
    );
    CREATE TABLE posts (
      id INTEGER PRIMARY KEY,
      author_id INTEGER NOT NULL REFERENCES users (id),
      title VARCHAR(200) NOT NULL
    );
    `,
    "sqlite",
  );
  const { order, cyclic } = topoSort(s);
  const data = buildData(s, order, cyclic, { rows: { users: 4, posts: 10 }, seed: 3 });

  const userIds = new Set(data.find((d) => d.table.key === "main.users")!.rows.map((r) => r.id));
  assert.equal(userIds.size, 4);
  const posts = data.find((d) => d.table.key === "main.posts")!.rows;
  for (const p of posts) {
    assert.ok(userIds.has(p.author_id), "FK points at a real user");
  }
  for (const u of data.find((d) => d.table.key === "main.users")!.rows) {
    assert.ok(["active", "banned"].includes(u.status as string), "enum idiom honored");
  }
});
