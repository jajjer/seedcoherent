/** Tests for dry-run planning: row counts, ordering, sampling, formatting. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPlan, buildSubsetPlan, formatPlan } from "../src/plan.js";
import { topoSort } from "../src/graph.js";
import type { TableData } from "../src/generate.js";
import { col, fk, idCol, schema, table } from "./helpers.js";
import type { Schema } from "../src/types.js";

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

function plan(s: Schema, config: Parameters<typeof buildPlan>[3]) {
  const { order, cyclic } = topoSort(s);
  return buildPlan(s, order, cyclic, config);
}

test("planned counts respect --rows and default-rows", () => {
  const p = plan(usersAndOrders(), { rows: { users: 1000 }, defaultRows: 42, seed: 1 });
  const users = p.tables.find((t) => t.key === "public.users")!;
  const orders = p.tables.find((t) => t.key === "public.orders")!;
  assert.equal(users.rows, 1000);
  assert.equal(orders.rows, 42);
  assert.equal(p.totalRows, 1042);
});

test("plan lists tables in dependency order", () => {
  const p = plan(usersAndOrders(), { defaultRows: 5, seed: 1 });
  assert.deepEqual(
    p.tables.map((t) => t.key),
    ["public.users", "public.orders"],
  );
});

test("sample is capped and does not reflect the full planned count", () => {
  const p = plan(usersAndOrders(), { rows: { users: 1000, orders: 5000 }, seed: 1 });
  for (const t of p.tables) {
    assert.ok(t.sample.length <= 3, `${t.key} sample too large: ${t.sample.length}`);
  }
  // The reported count is still the real plan, not the sample size.
  assert.equal(p.tables.find((t) => t.key === "public.users")!.rows, 1000);
});

test("sampled child rows still reference sampled parents", () => {
  const p = plan(usersAndOrders(), { rows: { users: 3, orders: 3 }, seed: 7 });
  const userIds = new Set(p.tables.find((t) => t.key === "public.users")!.sample.map((r) => r.id));
  for (const o of p.tables.find((t) => t.key === "public.orders")!.sample) {
    assert.ok(userIds.has(o.user_id), `orphan user_id ${o.user_id} in sample`);
  }
});

test("skipped tables report zero rows and no sample", () => {
  const p = plan(usersAndOrders(), { defaultRows: 5, skip: ["orders"], seed: 1 });
  const orders = p.tables.find((t) => t.key === "public.orders")!;
  assert.equal(orders.rows, 0);
  assert.equal(orders.skipped, true);
  assert.equal(orders.sample.length, 0);
});

/** A collected+anonymized subset slice: two users, one order that references them. */
function subsetData(): { data: TableData[]; cyclic: Set<string> } {
  const s = usersAndOrders();
  const users = s.tables.get("public.users")!;
  const orders = s.tables.get("public.orders")!;
  const data: TableData[] = [
    {
      table: users,
      columns: users.columns,
      rows: [
        { id: 1, email: "fake1@example.com" },
        { id: 2, email: "fake2@example.com" },
      ],
    },
    {
      table: orders,
      columns: orders.columns,
      rows: [{ id: 100, user_id: 1, total: 42 }],
    },
  ];
  return { data, cyclic: new Set() };
}

test("buildSubsetPlan reports exact counts and anonymized samples in order", () => {
  const { data, cyclic } = subsetData();
  const p = buildSubsetPlan(data, cyclic);
  assert.deepEqual(
    p.tables.map((t) => t.key),
    ["public.users", "public.orders"],
  );
  assert.equal(p.tables.find((t) => t.key === "public.users")!.rows, 2);
  assert.equal(p.tables.find((t) => t.key === "public.orders")!.rows, 1);
  assert.equal(p.totalRows, 3);
  // The sample carries the actual (anonymized) values that would be written.
  assert.equal(p.tables.find((t) => t.key === "public.users")!.sample[0].email, "fake1@example.com");
});

test("formatPlan marks a subset dry run as source-read, nothing-written", () => {
  const { data, cyclic } = subsetData();
  const out = formatPlan(buildSubsetPlan(data, cyclic), { subset: true });
  assert.match(out, /Subset plan \(dry run — source read, nothing written\)/);
  assert.match(out, /fake1@example\.com/);
  assert.match(out, /\b3\b/); // total rows
});

test("formatPlan renders counts, totals, and sample rows", () => {
  const out = formatPlan(plan(usersAndOrders(), { rows: { users: 2, orders: 3 }, seed: 1 }));
  assert.match(out, /Plan \(dry run/);
  assert.match(out, /public\.users/);
  assert.match(out, /public\.orders/);
  assert.match(out, /Sample rows:/);
  // Total of 2 + 3 rows appears in the summary line.
  assert.match(out, /\b5\b/);
});
