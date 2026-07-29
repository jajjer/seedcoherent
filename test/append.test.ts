/**
 * Tests for append mode: growing tables in a database that already has data.
 * A FakeFetcher stands in for the live DB so the closure logic is exercised
 * off-DB, mirroring the subset tests.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { appendTargets, planAppend } from "../src/append.js";
import { buildData, type Row } from "../src/generate.js";
import { topoSort } from "../src/graph.js";
import { buildAppendPlan } from "../src/plan.js";
import type { RowFetcher } from "../src/subset.js";
import { col, fk, idCol, schema, table } from "./helpers.js";
import type { Config, Schema, TableInfo } from "../src/types.js";

/** In-memory fetcher: fetchRoots serves existing rows, maxInt reports the PK max. */
class FakeFetcher implements RowFetcher {
  constructor(private data: Record<string, Row[]>) {}
  async fetchRoots(t: TableInfo, limit: number): Promise<Row[]> {
    return (this.data[t.name] ?? []).slice(0, limit);
  }
  async fetchByKeys(): Promise<Row[]> {
    return [];
  }
  async maxInt(t: TableInfo, column: string): Promise<number | null> {
    const rows = this.data[t.name] ?? [];
    if (rows.length === 0) return null;
    return Math.max(...rows.map((r) => Number(r[column])));
  }
}

/** users (has data) <- orders (grown). */
function shopSchema(): Schema {
  const users = table("users", {
    columns: [idCol(), col("email"), col("first_name")],
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

const existingUsers: Row[] = [
  { id: 5, email: "a@x.com", first_name: "Ann" },
  { id: 6, email: "b@x.com", first_name: "Bob" },
  { id: 7, email: "c@x.com", first_name: "Cara" },
];

test("append grows only the tables named in --rows, not the whole schema", async () => {
  const s = shopSchema();
  const config: Config = { rows: { orders: 4 }, seed: 1 };
  assert.deepEqual([...appendTargets(s, config)], ["public.orders"]);

  const { order, cyclic } = topoSort(s);
  const ctx = await planAppend(s, order, config, new FakeFetcher({ users: existingUsers }));
  const data = buildData(s, order, cyclic, config, ctx);

  // Only orders is emitted; users is a read-only parent.
  assert.deepEqual(
    data.map((d) => d.table.name),
    ["orders"],
  );
  assert.equal(data[0].rows.length, 4);
});

test("appended rows reference parent rows that already exist in the DB", async () => {
  const s = shopSchema();
  const config: Config = { rows: { orders: 20 }, seed: 3 };
  const { order, cyclic } = topoSort(s);
  const ctx = await planAppend(s, order, config, new FakeFetcher({ users: existingUsers }));
  const orders = buildData(s, order, cyclic, config, ctx)[0].rows;

  const validIds = new Set(existingUsers.map((u) => u.id));
  for (const o of orders) {
    assert.ok(validIds.has(o.user_id), `order.user_id ${o.user_id} must be an existing user id`);
  }
});

test("synthetic ids continue past the existing max instead of restarting at 1", async () => {
  const s = shopSchema();
  const existingOrders: Row[] = [{ id: 100, user_id: 5, total: 1 }, { id: 200, user_id: 6, total: 2 }];
  const config: Config = { rows: { orders: 3 }, seed: 7 };
  const { order, cyclic } = topoSort(s);
  const ctx = await planAppend(
    s,
    order,
    config,
    new FakeFetcher({ users: existingUsers, orders: existingOrders }),
  );
  const orders = buildData(s, order, cyclic, config, ctx)[0].rows;

  // max existing id is 200, so new ids are 201, 202, 203.
  assert.deepEqual(orders.map((o) => o.id), [201, 202, 203]);
});

test("an empty target table starts synthetic ids at 1", async () => {
  const s = shopSchema();
  const config: Config = { rows: { orders: 2 }, seed: 7 };
  const { order, cyclic } = topoSort(s);
  const ctx = await planAppend(s, order, config, new FakeFetcher({ users: existingUsers }));
  const orders = buildData(s, order, cyclic, config, ctx)[0].rows;
  assert.deepEqual(orders.map((o) => o.id), [1, 2]);
});

test("growing a parent and its child together keeps them referentially coherent", async () => {
  const s = shopSchema();
  // Both users and orders are grown; orders must reference the newly-made users,
  // whose ids continue past the existing max (7 → 8, 9).
  const config: Config = { rows: { users: 2, orders: 10 }, seed: 2 };
  const { order, cyclic } = topoSort(s);
  const ctx = await planAppend(s, order, config, new FakeFetcher({ users: existingUsers }));
  const data = buildData(s, order, cyclic, config, ctx);
  const users = data.find((d) => d.table.name === "users")!.rows;
  const orders = data.find((d) => d.table.name === "orders")!.rows;

  assert.deepEqual(users.map((u) => u.id), [8, 9]);
  const newIds = new Set(users.map((u) => u.id));
  for (const o of orders) {
    assert.ok(newIds.has(o.user_id), "child references a newly-generated parent, not an existing one");
  }
});

test("the append dry-run plan lists only grown tables with real FK samples", async () => {
  const s = shopSchema();
  const config: Config = { rows: { orders: 500 }, seed: 4 };
  const { order, cyclic } = topoSort(s);
  const ctx = await planAppend(s, order, config, new FakeFetcher({ users: existingUsers }));
  const plan = buildAppendPlan(s, order, cyclic, config, ctx);

  assert.deepEqual(plan.tables.map((t) => t.key), ["public.orders"]);
  assert.equal(plan.tables[0].rows, 500); // reported count is the full ask, not the capped sample
  const validIds = new Set(existingUsers.map((u) => u.id));
  for (const row of plan.tables[0].sample) {
    assert.ok(validIds.has(row.user_id));
  }
});

test("append output is deterministic for a fixed seed", async () => {
  const s = shopSchema();
  const config: Config = { rows: { orders: 8 }, seed: 42 };
  const { order, cyclic } = topoSort(s);
  const run = async () => {
    const ctx = await planAppend(s, order, config, new FakeFetcher({ users: existingUsers }));
    return buildData(s, order, cyclic, config, ctx)[0].rows;
  };
  assert.deepEqual(await run(), await run());
});
