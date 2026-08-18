/** Tests for row generation: FK integrity, uniqueness, ids, skip, determinism. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildData, generateInto, CollectSink } from "../src/generate.js";
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

function usersWithBio(): Schema {
  const users = table("users", {
    columns: [idCol(), col("email", { udtName: "text" }), col("bio", { udtName: "text", nullable: true })],
    primaryKey: ["id"],
    uniques: [["email"]],
  });
  return schema(users);
}

test("null rate 1 leaves a nullable column NULL on every row", () => {
  const data = build(usersWithBio(), { rows: { users: 30 }, nullRates: { "users.bio": 1 }, seed: 1 });
  const bios = rowsFor(data, "public.users").map((r) => r.bio);
  assert.ok(bios.every((b) => b === null), "expected every bio to be NULL");
});

test("null rate 0 fills a nullable column on every row", () => {
  const data = build(usersWithBio(), { rows: { users: 30 }, nullRates: { "users.bio": 0 }, seed: 1 });
  const bios = rowsFor(data, "public.users").map((r) => r.bio);
  assert.ok(bios.every((b) => b !== null), "expected no bio to be NULL");
});

test("null rate resolves by bare column name too", () => {
  const data = build(usersWithBio(), { rows: { users: 20 }, nullRates: { bio: 1 }, seed: 1 });
  const bios = rowsFor(data, "public.users").map((r) => r.bio);
  assert.ok(bios.every((b) => b === null), "expected bare-name null rate to apply");
});

test("a NOT NULL column ignores a configured null rate", () => {
  const data = build(usersWithBio(), { rows: { users: 20 }, nullRates: { "users.email": 1 }, seed: 1 });
  const emails = rowsFor(data, "public.users").map((r) => r.email);
  assert.ok(emails.every((e) => e !== null), "NOT NULL column must never be nulled");
});

test("an unconfigured null rate leaves default output byte-identical", () => {
  const base = build(usersWithBio(), { rows: { users: 25 }, seed: 9 });
  const withEmpty = build(usersWithBio(), { rows: { users: 25 }, nullRates: {}, seed: 9 });
  assert.deepEqual(withEmpty, base);
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

// ---- CHECK constraints ----

test("numeric CHECK lower bound is respected (price > 0)", () => {
  const t = table("products", {
    columns: [idCol(), col("price", { udtName: "numeric", numericScale: 2 })],
    primaryKey: ["id"],
    checks: [{ expr: "(price > (0)::numeric)" }],
  });
  const rows = rowsFor(build(schema(t), { rows: { products: 50 }, seed: 1 }), "public.products");
  for (const r of rows) assert.ok((r.price as number) > 0, `price ${r.price} not > 0`);
});

test("integer CHECK range is respected (rating BETWEEN 1 AND 5)", () => {
  const t = table("reviews", {
    columns: [idCol(), col("rating", { udtName: "int4" })],
    primaryKey: ["id"],
    checks: [{ expr: "((rating >= 1) AND (rating <= 5))" }],
  });
  const rows = rowsFor(build(schema(t), { rows: { reviews: 50 }, seed: 2 }), "public.reviews");
  for (const r of rows) {
    const v = r.rating as number;
    assert.ok(v >= 1 && v <= 5, `rating ${v} outside [1,5]`);
  }
});

test("membership CHECK confines values to the allowed set", () => {
  const t = table("tickets", {
    columns: [idCol(), col("state", { udtName: "text" })],
    primaryKey: ["id"],
    checks: [{ expr: "(state = ANY (ARRAY['open'::text, 'closed'::text]))" }],
  });
  const rows = rowsFor(build(schema(t), { rows: { tickets: 30 }, seed: 3 }), "public.tickets");
  for (const r of rows) {
    assert.ok(["open", "closed"].includes(r.state as string), `unexpected state ${r.state}`);
  }
});

test("length CHECK forces a minimum string length", () => {
  const t = table("codes", {
    columns: [idCol(), col("token", { udtName: "text" })],
    primaryKey: ["id"],
    checks: [{ expr: "(char_length(token) >= 12)" }],
  });
  const rows = rowsFor(build(schema(t), { rows: { codes: 40 }, seed: 4 }), "public.codes");
  for (const r of rows) {
    assert.ok((r.token as string).length >= 12, `token too short: "${r.token}"`);
  }
});

test("user column override still wins over a CHECK bound", () => {
  const t = table("products", {
    columns: [idCol(), col("price", { udtName: "numeric" })],
    primaryKey: ["id"],
    checks: [{ expr: "(price > (0)::numeric)" }],
  });
  const rows = rowsFor(
    build(schema(t), { rows: { products: 5 }, columns: { "products.price": { value: 42 } }, seed: 1 }),
    "public.products",
  );
  for (const r of rows) assert.equal(r.price, 42);
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

// ---- streaming (generateInto / CollectSink) ----

/** Drive generateInto with a CollectSink and return the materialized data. */
async function collect(s: Schema, config: Config, batchSize?: number) {
  const { order, cyclic } = topoSort(s);
  const sink = new CollectSink();
  const stats = await generateInto(s, order, cyclic, config, sink, batchSize);
  return { data: sink.data, stats };
}

test("generateInto + CollectSink reproduces buildData exactly", async () => {
  const config: Config = { rows: { users: 10, orders: 40 }, seed: 42 };
  const expected = build(usersAndOrders(), config);
  const { data } = await collect(usersAndOrders(), config);
  assert.deepEqual(data, expected);
});

test("output is byte-identical across batch sizes", async () => {
  const config: Config = { rows: { users: 25, orders: 100 }, seed: 7 };
  const base = toSql(build(usersAndOrders(), config));
  for (const batchSize of [1, 3, 100, 10000]) {
    const { data } = await collect(usersAndOrders(), config, batchSize);
    assert.equal(toSql(data), base, `batchSize=${batchSize} changed output`);
  }
});

test("generateInto reports per-table kept-row counts", async () => {
  const { stats } = await collect(usersAndOrders(), { rows: { users: 10, orders: 40 }, seed: 42 }, 7);
  const byKey = new Map(stats.map((s) => [s.table.key, s.rows]));
  assert.equal(byKey.get("public.users"), 10);
  assert.equal(byKey.get("public.orders"), 40);
});
