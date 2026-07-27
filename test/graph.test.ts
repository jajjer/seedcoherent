/** Tests for topological ordering of tables by foreign-key dependency. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { topoSort } from "../src/graph.js";
import { col, fk, idCol, schema, table } from "./helpers.js";

/** Index of a table key within the produced order. */
function pos(order: { key: string }[], key: string): number {
  return order.findIndex((t) => t.key === key);
}

test("parents are ordered before children", () => {
  const users = table("users", { columns: [idCol()], primaryKey: ["id"] });
  const orders = table("orders", {
    columns: [idCol(), col("user_id", { udtName: "int4" })],
    primaryKey: ["id"],
    foreignKeys: [fk(["user_id"], "users", ["id"])],
  });
  const { order, cyclic } = topoSort(schema(orders, users));

  assert.ok(pos(order, "public.users") < pos(order, "public.orders"));
  assert.equal(cyclic.size, 0);
  assert.equal(order.length, 2);
});

test("multi-level dependency chain is fully ordered", () => {
  const a = table("a", { columns: [idCol()], primaryKey: ["id"] });
  const b = table("b", {
    columns: [idCol(), col("a_id", { udtName: "int4" })],
    primaryKey: ["id"],
    foreignKeys: [fk(["a_id"], "a", ["id"])],
  });
  const c = table("c", {
    columns: [idCol(), col("b_id", { udtName: "int4" })],
    primaryKey: ["id"],
    foreignKeys: [fk(["b_id"], "b", ["id"])],
  });
  const { order } = topoSort(schema(c, b, a));

  assert.ok(pos(order, "public.a") < pos(order, "public.b"));
  assert.ok(pos(order, "public.b") < pos(order, "public.c"));
});

test("self-reference is marked cyclic but table is still ordered", () => {
  const employees = table("employees", {
    columns: [idCol(), col("manager_id", { udtName: "int4", nullable: true })],
    primaryKey: ["id"],
    foreignKeys: [fk(["manager_id"], "employees", ["id"])],
  });
  const { order, cyclic } = topoSort(schema(employees));

  assert.equal(order.length, 1);
  assert.ok(cyclic.has("public.employees"));
});

test("a true two-table cycle is broken and both marked cyclic", () => {
  const a = table("a", {
    columns: [idCol(), col("b_id", { udtName: "int4", nullable: true })],
    primaryKey: ["id"],
    foreignKeys: [fk(["b_id"], "b", ["id"])],
  });
  const b = table("b", {
    columns: [idCol(), col("a_id", { udtName: "int4", nullable: true })],
    primaryKey: ["id"],
    foreignKeys: [fk(["a_id"], "a", ["id"])],
  });
  const { order, cyclic } = topoSort(schema(a, b));

  assert.equal(order.length, 2);
  assert.ok(cyclic.has("public.a"));
  assert.ok(cyclic.has("public.b"));
});

test("FK to a table outside the introspected set is ignored", () => {
  const orders = table("orders", {
    columns: [idCol(), col("user_id", { udtName: "int4" })],
    primaryKey: ["id"],
    foreignKeys: [fk(["user_id"], "users", ["id"])], // users not in schema
  });
  const { order, cyclic } = topoSort(schema(orders));

  assert.equal(order.length, 1);
  assert.equal(cyclic.size, 0);
});

test("composite foreign key still orders parent first", () => {
  const parent = table("parent", {
    columns: [col("a", { udtName: "int4" }), col("b", { udtName: "int4" })],
    primaryKey: ["a", "b"],
  });
  const child = table("child", {
    columns: [idCol(), col("pa", { udtName: "int4" }), col("pb", { udtName: "int4" })],
    primaryKey: ["id"],
    foreignKeys: [fk(["pa", "pb"], "parent", ["a", "b"])],
  });
  const { order } = topoSort(schema(child, parent));

  assert.ok(pos(order, "public.parent") < pos(order, "public.child"));
});

test("every table receives exactly one order slot", () => {
  const a = table("a", { columns: [idCol()], primaryKey: ["id"] });
  const b = table("b", { columns: [idCol()], primaryKey: ["id"] });
  const c = table("c", { columns: [idCol()], primaryKey: ["id"] });
  const { order } = topoSort(schema(a, b, c));

  assert.deepEqual(
    [...order.map((t) => t.key)].sort(),
    ["public.a", "public.b", "public.c"],
  );
});
