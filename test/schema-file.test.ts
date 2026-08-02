/** Tests for the offline DDL front-end: parse a .sql schema into our Schema model. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildData } from "../src/generate.js";
import { topoSort } from "../src/graph.js";
import { loadSchemaFromDdl } from "../src/schema-file.js";
import { parseChecks } from "../src/checks.js";
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

test("maps columns, types, nullability, and length/precision", () => {
  const s = loadSchemaFromDdl(`
    CREATE TABLE users (
      id           SERIAL PRIMARY KEY,
      email        VARCHAR(255) NOT NULL UNIQUE,
      bio          TEXT,
      balance      NUMERIC(10, 2) NOT NULL,
      active       BOOLEAN NOT NULL DEFAULT TRUE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  const users = tbl(s, "public.users");

  const id = column(users, "id");
  assert.equal(id.dataType, "integer");
  assert.ok(id.hasDefault, "serial implies a default");
  assert.deepEqual(users.primaryKey, ["id"]);

  const email = column(users, "email");
  assert.equal(email.dataType, "text");
  assert.equal(email.maxLength, 255);
  assert.equal(email.nullable, false);
  assert.deepEqual(users.uniques, [["email"]]);

  assert.equal(column(users, "bio").nullable, true);

  const balance = column(users, "balance");
  assert.equal(balance.dataType, "decimal");
  assert.equal(balance.numericPrecision, 10);
  assert.equal(balance.numericScale, 2);

  const active = column(users, "active");
  assert.equal(active.dataType, "boolean");
  assert.ok(active.hasDefault);

  assert.equal(column(users, "created_at").dataType, "timestamp");
});

test("resolves enum types declared with CREATE TYPE", () => {
  const s = loadSchemaFromDdl(`
    CREATE TYPE order_status AS ENUM ('pending', 'paid', 'shipped');
    CREATE TABLE orders (
      id     SERIAL PRIMARY KEY,
      status order_status NOT NULL DEFAULT 'pending'
    );
  `);
  const status = column(tbl(s, "public.orders"), "status");
  assert.equal(status.dataType, "enum");
  assert.deepEqual(status.enumValues, ["pending", "paid", "shipped"]);
});

test("captures inline, table-level, and ALTER TABLE foreign keys", () => {
  const s = loadSchemaFromDdl(`
    CREATE TABLE users (id SERIAL PRIMARY KEY);
    CREATE TABLE orders (
      id      SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id)
    );
    CREATE TABLE order_items (
      order_id   INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      PRIMARY KEY (order_id, product_id),
      CONSTRAINT fk_order FOREIGN KEY (order_id) REFERENCES orders(id)
    );
    ALTER TABLE order_items ADD CONSTRAINT fk_prod FOREIGN KEY (product_id) REFERENCES products(id);
    CREATE TABLE products (id SERIAL PRIMARY KEY);
  `);

  const orders = tbl(s, "public.orders");
  assert.deepEqual(orders.foreignKeys, [
    { columns: ["user_id"], refTable: "public.users", refColumns: ["id"] },
  ]);

  const items = tbl(s, "public.order_items");
  assert.deepEqual(items.primaryKey, ["order_id", "product_id"]);
  assert.deepEqual(items.foreignKeys, [
    { columns: ["order_id"], refTable: "public.orders", refColumns: ["id"] },
    { columns: ["product_id"], refTable: "public.products", refColumns: ["id"] },
  ]);
});

test("normalizes CHECK constraints the check parser can read", () => {
  const s = loadSchemaFromDdl(`
    CREATE TABLE line_items (
      price    NUMERIC NOT NULL CHECK (price > 0),
      quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 100),
      code     TEXT CHECK (code IN ('a', 'b', 'c')),
      label    TEXT CHECK (char_length(label) >= 3)
    );
  `);
  const bounds = parseChecks(tbl(s, "public.line_items").checks);

  assert.equal(bounds.get("price")?.min, 0);
  assert.equal(bounds.get("price")?.minExclusive, true);

  assert.equal(bounds.get("quantity")?.min, 1);
  assert.equal(bounds.get("quantity")?.max, 100);

  assert.deepEqual(bounds.get("code")?.in, ["a", "b", "c"]);

  assert.equal(bounds.get("label")?.minLength, 3);
});

test("marks identity and generated columns DB-assigned", () => {
  const s = loadSchemaFromDdl(`
    CREATE TABLE t (
      id    INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      base  INTEGER NOT NULL,
      total INTEGER GENERATED ALWAYS AS (base * 2) STORED
    );
  `);
  const t = tbl(s, "public.t");
  assert.equal(column(t, "id").isIdentity, true);
  assert.equal(column(t, "total").isGenerated, true);
  assert.equal(column(t, "total").isIdentity, false);
});

test("respects a non-public schema qualifier", () => {
  const s = loadSchemaFromDdl(`
    CREATE TABLE app.accounts (id SERIAL PRIMARY KEY);
  `);
  const t = tbl(s, "app.accounts");
  assert.equal(t.schema, "app");
  assert.equal(t.name, "accounts");
});

test("skips statements the parser can't handle without aborting", () => {
  const s = loadSchemaFromDdl(`
    SET statement_timeout = 0;
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    COMMENT ON SCHEMA public IS 'standard';
    CREATE TABLE keep (id SERIAL PRIMARY KEY, name TEXT NOT NULL);
  `);
  assert.ok(s.tables.has("public.keep"));
  assert.equal(column(tbl(s, "public.keep"), "name").dataType, "text");
});

test("end-to-end: generates coherent, constraint-valid rows", () => {
  const s = loadSchemaFromDdl(`
    CREATE TYPE order_status AS ENUM ('pending', 'paid', 'shipped');
    CREATE TABLE users (
      id    SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE
    );
    CREATE TABLE orders (
      id       SERIAL PRIMARY KEY,
      user_id  INTEGER NOT NULL REFERENCES users(id),
      status   order_status NOT NULL DEFAULT 'pending',
      quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 10)
    );
  `);
  const { order, cyclic } = topoSort(s);
  const data = buildData(s, order, cyclic, { rows: { users: 5, orders: 20 }, seed: 7 });

  const userIds = new Set(
    data.find((d) => d.table.key === "public.users")!.rows.map((r) => r.id),
  );
  assert.equal(userIds.size, 5);

  const orders = data.find((d) => d.table.key === "public.orders")!.rows;
  assert.equal(orders.length, 20);
  for (const o of orders) {
    assert.ok(userIds.has(o.user_id), "FK points at a real user");
    assert.ok(["pending", "paid", "shipped"].includes(o.status as string), "enum value in range");
    assert.ok((o.quantity as number) >= 1 && (o.quantity as number) <= 10, "CHECK bound honored");
  }
});
