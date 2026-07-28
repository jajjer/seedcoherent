/** Tests for FK fan-out distributions: sampler shape, parsing, and generation. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Faker, en } from "@faker-js/faker";
import { buildData } from "../src/generate.js";
import { distributionFor, resolveDistribution } from "../src/distribution.js";
import { parseDistSpecs } from "../src/config.js";
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

/** users (parent) + orders (child) with a configurable FK distribution. */
function usersAndOrders(): Schema {
  const users = table("users", { columns: [idCol()], primaryKey: ["id"] });
  const orders = table("orders", {
    columns: [idCol(), col("user_id", { udtName: "int4" })],
    primaryKey: ["id"],
    foreignKeys: [fk(["user_id"], "users", ["id"])],
  });
  return schema(users, orders);
}

/** Map parent-id -> child count for the orders.user_id FK. */
function fanout(data: ReturnType<typeof build>): Map<unknown, number> {
  const counts = new Map<unknown, number>();
  for (const r of rowsFor(data, "public.orders")) {
    counts.set(r.user_id, (counts.get(r.user_id) ?? 0) + 1);
  }
  return counts;
}

// ---- sampler shape ----

test("zipf concentrates draws on a few indices; uniform spreads them", () => {
  const items = Array.from({ length: 100 }, (_, i) => i);

  const draw = (dist: ReturnType<typeof distributionFor>) => {
    const f = new Faker({ locale: [en] });
    f.seed(7);
    const sample = dist.bind(items);
    const counts = new Array(100).fill(0);
    for (let i = 0; i < 10000; i++) {
      const idx = sample(f);
      assert.ok(idx >= 0 && idx < 100, `index ${idx} out of range`); // always a real item
      counts[idx]++;
    }
    return counts;
  };

  const zipfCounts = draw(distributionFor("zipf"));
  const uniformCounts = draw(distributionFor("uniform"));

  const head = (c: number[]) => c.slice(0, 10).reduce((a, b) => a + b, 0);
  const tail = (c: number[]) => c.slice(90).reduce((a, b) => a + b, 0);

  // Zipf piles the mass onto the low indices; uniform stays roughly flat.
  assert.ok(head(zipfCounts) > tail(zipfCounts) * 5, "zipf head should dwarf its tail");
  assert.ok(head(uniformCounts) < tail(uniformCounts) * 2, "uniform head ~ tail");
  // And zipf's most-popular index far exceeds uniform's.
  assert.ok(Math.max(...zipfCounts) > Math.max(...uniformCounts) * 3);
});

test("higher skew produces a heavier head", () => {
  const items = Array.from({ length: 100 }, (_, i) => i);
  const headFor = (skew: number) => {
    const f = new Faker({ locale: [en] });
    f.seed(3);
    const sample = distributionFor({ kind: "zipf", skew }).bind(items);
    let head = 0;
    for (let i = 0; i < 10000; i++) if (sample(f) < 10) head++;
    return head;
  };
  assert.ok(headFor(2) > headFor(1), "skew 2 should hit the head more than skew 1");
});

// ---- resolveDistribution key precedence ----

test("resolveDistribution honors qualified, keyed, and bare column keys", () => {
  const t = table("orders", {
    columns: [idCol(), col("user_id", { udtName: "int4" })],
    foreignKeys: [fk(["user_id"], "users", ["id"])],
  });
  const items = [0, 1];
  const f = new Faker({ locale: [en] });
  f.seed(1);

  // A configured FK returns a non-uniform sampler; an unconfigured one is uniform.
  const configured = resolveDistribution(t, ["user_id"], { "orders.user_id": "zipf" });
  const bare = resolveDistribution(t, ["user_id"], { user_id: "zipf" });
  const none = resolveDistribution(t, ["user_id"], {});
  assert.notEqual(configured, none);
  assert.notEqual(bare, none);
  // Uniform is a shared singleton, so an absent key resolves to the same fn.
  assert.equal(none, resolveDistribution(t, ["user_id"], {}));
});

// ---- parseDistSpecs ----

test("parseDistSpecs handles zipf, skew, uniform, and rejects bad input", () => {
  assert.deepEqual(parseDistSpecs(["orders.user_id=zipf"]), { "orders.user_id": "zipf" });
  assert.deepEqual(parseDistSpecs(["a.b=zipf:2"]), { "a.b": { kind: "zipf", skew: 2 } });
  assert.deepEqual(parseDistSpecs(["a.b=zipf:0.5"]), { "a.b": { kind: "zipf", skew: 0.5 } });
  assert.deepEqual(parseDistSpecs(["a.b=uniform"]), { "a.b": "uniform" });
  assert.throws(() => parseDistSpecs(["nokind"]), /expected column=kind/);
  assert.throws(() => parseDistSpecs(["a.b=poisson"]), /Unknown distribution/);
  assert.throws(() => parseDistSpecs(["a.b=zipf:0"]), /Invalid skew/);
  assert.throws(() => parseDistSpecs(["a.b=zipf:-1"]), /Invalid skew/);
  assert.throws(() => parseDistSpecs(["a.b=uniform:2"]), /uniform takes no skew/);
});

// ---- generation behavior ----

test("zipf FK skews child counts while staying referentially correct", () => {
  const s = usersAndOrders();
  const cfg = { rows: { users: 50, orders: 2000 }, seed: 11 };
  const uniform = fanout(build(s, cfg));
  const zipf = fanout(build(s, { ...cfg, distributions: { "orders.user_id": "zipf" } }));

  const userIds = new Set(rowsFor(build(s, cfg), "public.users").map((r) => r.id));
  for (const id of zipf.keys()) assert.ok(userIds.has(id), `orphan user_id ${id}`); // still coherent

  const max = (m: Map<unknown, number>) => Math.max(...m.values());
  // How few of the busiest parents it takes to account for half the children —
  // a compact measure of inequality (uniform needs ~half of them, zipf far fewer).
  const parentsForHalf = (m: Map<unknown, number>) => {
    const sorted = [...m.values()].sort((a, b) => b - a);
    const half = sorted.reduce((a, b) => a + b, 0) / 2;
    let acc = 0;
    let i = 0;
    while (acc < half) acc += sorted[i++];
    return i;
  };

  // The busiest parent under zipf collects far more than under a flat spread,
  // and the top handful of parents carries most of the children.
  assert.ok(max(zipf) > max(uniform) * 2, `zipf max ${max(zipf)} vs uniform ${max(uniform)}`);
  assert.ok(
    parentsForHalf(zipf) < parentsForHalf(uniform) / 2,
    `zipf half-cover ${parentsForHalf(zipf)} vs uniform ${parentsForHalf(uniform)}`,
  );
});

test("distributions are deterministic under a seed", () => {
  const s = usersAndOrders();
  const cfg = { rows: { users: 20, orders: 500 }, seed: 4, distributions: { "orders.user_id": "zipf" as const } };
  const a = rowsFor(build(s, cfg), "public.orders").map((r) => r.user_id);
  const b = rowsFor(build(s, cfg), "public.orders").map((r) => r.user_id);
  assert.deepEqual(a, b);
});

test("no distribution config leaves seeded output byte-identical to uniform", () => {
  const s = usersAndOrders();
  const cfg = { rows: { users: 20, orders: 500 }, seed: 9 };
  const withEmpty = rowsFor(build(s, { ...cfg, distributions: {} }), "public.orders").map((r) => r.user_id);
  const without = rowsFor(build(s, cfg), "public.orders").map((r) => r.user_id);
  assert.deepEqual(withEmpty, without);
});

test("composite FK copies a coherent tuple from one parent", () => {
  // parent has a two-column key; child references both columns together.
  const parent = table("parent", {
    columns: [col("a", { udtName: "int4" }), col("b", { udtName: "int4" })],
    primaryKey: ["a", "b"],
  });
  const child = table("child", {
    columns: [idCol(), col("pa", { udtName: "int4" }), col("pb", { udtName: "int4" })],
    primaryKey: ["id"],
    foreignKeys: [fk(["pa", "pb"], "parent", ["a", "b"])],
  });
  const data = build(schema(parent, child), {
    rows: { parent: 30, child: 200 },
    seed: 6,
    distributions: { "child.pa": "zipf" },
  });
  const validTuples = new Set(rowsFor(data, "public.parent").map((r) => `${r.a}|${r.b}`));
  for (const c of rowsFor(data, "public.child")) {
    assert.ok(validTuples.has(`${c.pa}|${c.pb}`), `(${c.pa}, ${c.pb}) is not a real parent tuple`);
  }
});
