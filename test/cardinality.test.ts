/** Tests for --cardinality: parsing, derived counts, assignment, and guards. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildData } from "../src/generate.js";
import { parseCardinalitySpecs, validateCardinality } from "../src/config.js";
import { topoSort } from "../src/graph.js";
import { col, fk, idCol, schema, table } from "./helpers.js";
import type { Config, Schema } from "../src/types.js";

function build(s: Schema, config: Config) {
  const { order, cyclic } = topoSort(s);
  return buildData(s, order, cyclic, config);
}

function rowsFor(data: ReturnType<typeof build>, key: string) {
  const td = data.find((d) => d.table.key === key);
  assert.ok(td, `expected data for ${key}`);
  return td.rows;
}

/** Map parent-id -> child count for the orders.user_id FK. */
function fanout(data: ReturnType<typeof build>): Map<unknown, number> {
  const counts = new Map<unknown, number>();
  for (const r of rowsFor(data, "public.orders")) {
    counts.set(r.user_id, (counts.get(r.user_id) ?? 0) + 1);
  }
  return counts;
}

/** users (parent) + orders (child, FK user_id). `uniqueFk` makes it 1:1-capable. */
function usersAndOrders(uniqueFk = false): Schema {
  const users = table("users", { columns: [idCol()], primaryKey: ["id"] });
  const orders = table("orders", {
    columns: [idCol(), col("user_id", { udtName: "int4" })],
    primaryKey: ["id"],
    uniques: uniqueFk ? [["user_id"]] : [],
    foreignKeys: [fk(["user_id"], "users", ["id"])],
  });
  return schema(users, orders);
}

// ---- parsing ----

test("parseCardinalitySpecs parses exact and range", () => {
  assert.deepEqual(parseCardinalitySpecs(["order_items.order_id=3"]), {
    "order_items.order_id": { min: 3, max: 3 },
  });
  assert.deepEqual(parseCardinalitySpecs(["orders.user_id=1-3"]), {
    "orders.user_id": { min: 1, max: 3 },
  });
  assert.deepEqual(parseCardinalitySpecs(["orders.user_id=0-1"]), {
    "orders.user_id": { min: 0, max: 1 },
  });
});

test("parseCardinalitySpecs rejects bad specs", () => {
  assert.throws(
    () => parseCardinalitySpecs(["orders.user_id=3-1"]),
    /min > max/,
  );
  assert.throws(
    () => parseCardinalitySpecs(["orders.user_id=-1"]),
    /non-negative/,
  );
  assert.throws(
    () => parseCardinalitySpecs(["orders.user_id=a-b"]),
    /non-negative/,
  );
  assert.throws(
    () => parseCardinalitySpecs(["orders.user_id=1.5"]),
    /non-negative/,
  );
  assert.throws(() => parseCardinalitySpecs(["orders.user_id"]), /expected/);
  assert.throws(() => parseCardinalitySpecs(["=3"]), /empty/);
});

test("validateCardinality rejects malformed config-file entries", () => {
  assert.throws(
    () => validateCardinality({ "orders.user_id": { min: 2, max: 1 } }),
    /min ≤ max/,
  );
  assert.throws(
    () => validateCardinality({ "orders.user_id": { min: -1, max: 3 } }),
    /non-negative/,
  );
  validateCardinality({ "orders.user_id": { min: 0, max: 3 } }); // ok
  validateCardinality(undefined); // ok
});

// ---- derived counts & assignment ----

test("exact cardinality: every parent gets exactly N children", () => {
  const data = build(usersAndOrders(), {
    rows: { users: 10 },
    cardinality: { "orders.user_id": { min: 2, max: 2 } },
    seed: 1,
  });
  const counts = fanout(data);
  assert.equal(rowsFor(data, "public.orders").length, 20); // 10 users * 2
  assert.equal(counts.size, 10); // every user referenced
  for (const c of counts.values()) assert.equal(c, 2);
});

test("exact cardinality overrides an explicit --rows for the child", () => {
  const data = build(usersAndOrders(), {
    rows: { users: 10, orders: 999 },
    cardinality: { "orders.user_id": { min: 3, max: 3 } },
    seed: 1,
  });
  assert.equal(rowsFor(data, "public.orders").length, 30); // 10*3, not 999
});

test("range cardinality keeps every parent within [min, max]", () => {
  const data = build(usersAndOrders(), {
    rows: { users: 50 },
    cardinality: { "orders.user_id": { min: 1, max: 3 } },
    seed: 7,
  });
  const counts = fanout(data);
  let total = 0;
  for (const c of counts.values()) {
    assert.ok(c >= 1 && c <= 3, `count ${c} out of [1,3]`);
    total += c;
  }
  assert.equal(counts.size, 50); // min=1 ⇒ no childless parents
  assert.equal(rowsFor(data, "public.orders").length, total);
});

test("min=0 lets some parents be childless (fewer total children)", () => {
  const data = build(usersAndOrders(), {
    rows: { users: 100 },
    cardinality: { "orders.user_id": { min: 0, max: 2 } },
    seed: 3,
  });
  const counts = fanout(data);
  assert.ok(counts.size < 100, "some parents should be childless");
  for (const c of counts.values()) assert.ok(c >= 1 && c <= 2);
});

test("1:1 cardinality on a UNIQUE FK: each parent exactly one child, no dup", () => {
  const data = build(usersAndOrders(true), {
    rows: { users: 25 },
    cardinality: { "orders.user_id": { min: 1, max: 1 } },
    seed: 9,
  });
  const orders = rowsFor(data, "public.orders");
  assert.equal(orders.length, 25);
  const seen = new Set(orders.map((o) => o.user_id));
  assert.equal(seen.size, 25); // every FK value distinct ⇒ true 1:1
});

test("every child FK references a real parent (zero orphans)", () => {
  const data = build(usersAndOrders(), {
    rows: { users: 8 },
    cardinality: { "orders.user_id": { min: 1, max: 4 } },
    seed: 5,
  });
  const userIds = new Set(rowsFor(data, "public.users").map((u) => u.id));
  for (const o of rowsFor(data, "public.orders")) {
    assert.ok(userIds.has(o.user_id), `orphan user_id ${o.user_id}`);
  }
});

test("cardinality is deterministic under --seed", () => {
  const cfg: Config = {
    rows: { users: 40 },
    cardinality: { "orders.user_id": { min: 1, max: 5 } },
    seed: 42,
  };
  const a = fanout(build(usersAndOrders(), cfg));
  const b = fanout(build(usersAndOrders(), cfg));
  assert.deepEqual([...a.entries()].sort(), [...b.entries()].sort());
});

test("empty parent pool ⇒ zero children", () => {
  const data = build(usersAndOrders(), {
    rows: { users: 0 },
    cardinality: { "orders.user_id": { min: 1, max: 3 } },
    seed: 1,
  });
  assert.equal(rowsFor(data, "public.orders").length, 0);
});

// ---- guards ----

test("rejects two cardinality specs on one table", () => {
  const users = table("users", { columns: [idCol()], primaryKey: ["id"] });
  const regions = table("regions", { columns: [idCol()], primaryKey: ["id"] });
  const orders = table("orders", {
    columns: [
      idCol(),
      col("user_id", { udtName: "int4" }),
      col("region_id", { udtName: "int4" }),
    ],
    primaryKey: ["id"],
    foreignKeys: [
      fk(["user_id"], "users", ["id"]),
      fk(["region_id"], "regions", ["id"]),
    ],
  });
  const s = schema(users, regions, orders);
  assert.throws(
    () =>
      build(s, {
        rows: { users: 5, regions: 5 },
        cardinality: {
          "orders.user_id": { min: 1, max: 2 },
          "orders.region_id": { min: 1, max: 2 },
        },
      }),
    /at most one/,
  );
});

test("rejects cardinality + distribution on the same FK", () => {
  assert.throws(
    () =>
      build(usersAndOrders(), {
        rows: { users: 5 },
        cardinality: { "orders.user_id": { min: 1, max: 2 } },
        distributions: { "orders.user_id": "zipf" },
      }),
    /both .*cardinality.*distribution|pick one/,
  );
});

test("rejects cardinality on a self-referential FK", () => {
  const employees = table("employees", {
    columns: [idCol(), col("manager_id", { udtName: "int4", nullable: true })],
    primaryKey: ["id"],
    foreignKeys: [fk(["manager_id"], "employees", ["id"])],
  });
  assert.throws(
    () =>
      build(schema(employees), {
        rows: { employees: 5 },
        cardinality: { "employees.manager_id": { min: 1, max: 2 } },
      }),
    /self-referential/,
  );
});
