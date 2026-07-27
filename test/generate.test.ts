/** Tests for row generation: FK integrity, uniqueness, ids, skip, determinism. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildData } from "../src/generate.js";
import { toSql } from "../src/emit.js";
import { topoSort } from "../src/graph.js";
import { col, fk, idCol, schema, table } from "./helpers.js";
import type { Config, Schema } from "../src/types.js";

/** Introspect-free build: topo-sort then generate. */
function build(s: Schema, config: Config) {
  const { order, cyclic } = topoSort(s);
  return buildData(s, order, cyclic, config);
}

function usersAndOrders(): Schema {
  const users = table("users", {
    columns: [idCol(), col("email", { udtName: "text" })],
    primaryKey: ["id"],
    uniques: [["email"]],
  });
  const orders = table("orders", {
    columns: [idCol(), col("user_id", { udtName: "int4" }), col("total", { udtName: "numeric" })],
    primaryKey: ["id"],
    foreignKeys: [fk(["user_id"], "users", ["id"])],
  });
  return schema(users, orders);
}

function rowsFor(data: ReturnType<typeof build>, key: string) {
  const td = data.find((d) => d.table.key === key);
  assert.ok(td, `expected data for ${key}`);
  return td.rows;
}

test("child FK values reference existing parent rows", () => {
  const data = build(usersAndOrders(), { rows: { users: 5, orders: 30 }, seed: 1 });
  const userIds = new Set(rowsFor(data, "public.users").map((r) => r.id));
  const orders = rowsFor(data, "public.orders");

  assert.equal(orders.length, 30);
  for (const o of orders) {
    assert.ok(userIds.has(o.user_id), `orphan user_id ${o.user_id}`);
  }
});

test("synthetic integer identity PKs are assigned 1..N", () => {
  const data = build(usersAndOrders(), { rows: { users: 4 }, seed: 1 });
  const ids = rowsFor(data, "public.users").map((r) => r.id);
  assert.deepEqual(ids, [1, 2, 3, 4]);
});

test("unique constraints are never violated within a table", () => {
  const data = build(usersAndOrders(), { rows: { users: 20 }, seed: 3 });
  const emails = rowsFor(data, "public.users").map((r) => r.email);
  assert.equal(new Set(emails).size, emails.length);
});

test("row count is capped when the unique domain is exhausted", () => {
  const tags = table("tags", {
    columns: [col("label", { udtName: "text" })],
    uniques: [["label"]],
  });
  const data = build(schema(tags), {
    rows: { tags: 10 },
    columns: { "tags.label": { values: ["a", "b", "c"] } },
    seed: 1,
  });
  const labels = rowsFor(data, "public.tags").map((r) => r.label);
  assert.equal(labels.length, 3);
  assert.deepEqual([...labels].sort(), ["a", "b", "c"]);
});

test("self-referential FK points at an existing row or null", () => {
  const employees = table("employees", {
    columns: [idCol(), col("manager_id", { udtName: "int4", nullable: true })],
    primaryKey: ["id"],
    foreignKeys: [fk(["manager_id"], "employees", ["id"])],
  });
  const data = build(schema(employees), { rows: { employees: 15 }, seed: 2 });
  const rows = rowsFor(data, "public.employees");
  const ids = new Set(rows.map((r) => r.id));
  for (const r of rows) {
    if (r.manager_id !== null) {
      assert.ok(ids.has(r.manager_id), `manager_id ${r.manager_id} has no row`);
    }
  }
});

test("skipped tables are omitted from the output entirely", () => {
  const data = build(usersAndOrders(), { rows: { users: 5, orders: 5 }, skip: ["orders"], seed: 1 });
  assert.ok(!data.some((d) => d.table.key === "public.orders"));
  assert.ok(rowsFor(data, "public.users").length > 0);
});

test("defaultRows applies to tables not listed in rows", () => {
  const data = build(usersAndOrders(), { defaultRows: 3, seed: 1 });
  assert.equal(rowsFor(data, "public.users").length, 3);
  assert.equal(rowsFor(data, "public.orders").length, 3);
});

test("GENERATED columns are excluded from emitted columns", () => {
  const t = table("t", {
    columns: [
      idCol(),
      col("price", { udtName: "numeric" }),
      col("price_with_tax", { udtName: "numeric", isGenerated: true }),
    ],
    primaryKey: ["id"],
  });
  const data = build(schema(t), { rows: { t: 2 }, seed: 1 });
  const emitted = data[0].columns.map((c) => c.name);
  assert.ok(!emitted.includes("price_with_tax"));
  assert.ok(emitted.includes("price"));
});

// ---- determinism ----

test("the same seed produces byte-identical SQL", () => {
  const s1 = toSql(build(usersAndOrders(), { rows: { users: 10, orders: 40 }, seed: 42 }));
  const s2 = toSql(build(usersAndOrders(), { rows: { users: 10, orders: 40 }, seed: 42 }));
  assert.equal(s1, s2);
});

test("different seeds produce different SQL", () => {
  const s1 = toSql(build(usersAndOrders(), { rows: { users: 10, orders: 40 }, seed: 1 }));
  const s2 = toSql(build(usersAndOrders(), { rows: { users: 10, orders: 40 }, seed: 2 }));
  assert.notEqual(s1, s2);
});
