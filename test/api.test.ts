/** Tests for the programmatic API (`seed`) — in-memory generation from DDL. */

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { seed } from "../src/index.js";

const DDL = `
  CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    first_name TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT now()
  );
  CREATE TABLE orders (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id),
    status TEXT NOT NULL,
    total NUMERIC(10,2) NOT NULL
  );
`;

test("seed generates the requested rows keyed by table name", async () => {
  const { data, tables } = await seed({ ddl: DDL, rows: { users: 3, orders: 5 }, seed: 42 });
  assert.deepEqual(Object.keys(data), ["users", "orders"]);
  assert.equal(data.users.length, 3);
  assert.equal(data.orders.length, 5);
  // Ordered, dependency-first, with metadata.
  assert.deepEqual(tables.map((t) => t.key), ["public.users", "public.orders"]);
  assert.equal(tables[0].schema, "public");
  assert.ok(tables[0].columns.includes("email"));
});

test("seed rows are referentially correct — FKs point at real parents", async () => {
  const { data } = await seed({ ddl: DDL, rows: { users: 4, orders: 20 }, seed: 7 });
  const ids = new Set(data.users.map((u) => u.id));
  assert.ok(data.orders.every((o) => ids.has(o.user_id)));
});

test("seed is deterministic for a given seed", async () => {
  const a = await seed({ ddl: DDL, rows: { users: 3, orders: 5 }, seed: 42 });
  const b = await seed({ ddl: DDL, rows: { users: 3, orders: 5 }, seed: 42 });
  assert.deepEqual(a.data, b.data);
});

test("column overrides steer generated values", async () => {
  const { data } = await seed({
    ddl: DDL,
    rows: { users: 5, orders: 10 },
    columns: { "orders.status": { value: "paid" } },
    seed: 1,
  });
  // status is NOT NULL, so a fixed value applies to every row.
  assert.ok(data.orders.every((o) => o.status === "paid"));
});

test("toSQL renders a runnable script in the source and overridden dialects", async () => {
  const result = await seed({ ddl: DDL, rows: { users: 2, orders: 2 }, seed: 3 });
  const pg = result.toSQL();
  assert.match(pg, /INSERT INTO "public"\."users"/);
  const my = result.toSQL("mysql");
  assert.match(my, /INSERT INTO `users`/);
});

test("seed reads a schemaFile from disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "seed-api-"));
  const path = join(dir, "schema.sql");
  await writeFile(path, DDL, "utf8");
  const { data } = await seed({ schemaFile: path, rows: { users: 2, orders: 0 }, seed: 5 });
  assert.equal(data.users.length, 2);
});

test("a bare table name that collides across schemas is keyed by its full key", async () => {
  const ddl = `
    CREATE TABLE a.items (id SERIAL PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE b.items (id SERIAL PRIMARY KEY, name TEXT NOT NULL);
  `;
  const { data } = await seed({ ddl, defaultRows: 1, seed: 1 });
  assert.deepEqual(Object.keys(data).sort(), ["a.items", "b.items"]);
});

test("seed requires exactly one schema source", async () => {
  await assert.rejects(() => seed({ rows: { users: 1 } }), /needs a schema source/);
  await assert.rejects(
    () => seed({ ddl: DDL, schemaFile: "x.sql" }),
    /mutually exclusive/,
  );
});

test("an invalid locale is rejected up front", async () => {
  await assert.rejects(() => seed({ ddl: DDL, locale: "not_a_locale" }));
});
