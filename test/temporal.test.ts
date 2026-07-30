/** Tests for temporal coherence: causal timestamps within a row and across FKs. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildData } from "../src/generate.js";
import { topoSort } from "../src/graph.js";
import { planTemporal, temporalWindow, timestampMs } from "../src/temporal.js";
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

/** users(id, created_at, updated_at) ← orders(id, user_id, created_at). */
function usersAndOrders(): Schema {
  const users = table("users", {
    columns: [
      idCol(),
      col("created_at", { udtName: "timestamptz" }),
      col("updated_at", { udtName: "timestamptz" }),
    ],
    primaryKey: ["id"],
  });
  const orders = table("orders", {
    columns: [idCol(), col("user_id", { udtName: "int4" }), col("created_at", { udtName: "timestamptz" })],
    primaryKey: ["id"],
    foreignKeys: [fk(["user_id"], "users", ["id"])],
  });
  return schema(users, orders);
}

test("updated_at is never earlier than created_at in the same row", () => {
  const data = build(usersAndOrders(), { rows: { users: 200 }, seed: 1 });
  for (const u of rowsFor(data, "public.users")) {
    assert.ok(
      timestampMs(u.updated_at)! >= timestampMs(u.created_at)!,
      `updated_at ${u.updated_at} < created_at ${u.created_at}`,
    );
  }
});

test("a child's created_at is never earlier than its parent's created_at", () => {
  const data = build(usersAndOrders(), { rows: { users: 50, orders: 500 }, seed: 7 });
  const userCreated = new Map(
    rowsFor(data, "public.users").map((u) => [u.id, timestampMs(u.created_at)!]),
  );
  for (const o of rowsFor(data, "public.orders")) {
    assert.ok(
      timestampMs(o.created_at)! >= userCreated.get(o.user_id)!,
      `order ${o.id} created ${o.created_at} precedes its user ${o.user_id}`,
    );
  }
});

test("creation timestamps land inside the [since, until] window", () => {
  const config: Config = { rows: { users: 300 }, seed: 3, since: "2020-06-01", until: "2020-12-31" };
  const win = temporalWindow(config);
  for (const u of rowsFor(build(usersAndOrders(), config), "public.users")) {
    const ms = timestampMs(u.created_at)!;
    assert.ok(ms >= win.sinceMs && ms <= win.untilMs, `created_at ${u.created_at} outside window`);
  }
});

test("a --column override on a temporal column is left untouched", () => {
  const config: Config = {
    rows: { users: 20 },
    seed: 2,
    columns: { "users.created_at": { value: "1999-01-01T00:00:00.000Z" } },
  };
  for (const u of rowsFor(build(usersAndOrders(), config), "public.users")) {
    assert.equal(u.created_at, "1999-01-01T00:00:00.000Z");
    // updated_at still follows the (pinned) created_at.
    assert.ok(timestampMs(u.updated_at)! >= timestampMs(u.created_at)!);
  }
});

test("expiry columns may run past `until`, activity columns may not", () => {
  const subs = table("subscriptions", {
    columns: [
      idCol(),
      col("created_at", { udtName: "timestamptz" }),
      col("last_login", { udtName: "timestamptz" }),
      col("expires_at", { udtName: "timestamptz" }),
    ],
    primaryKey: ["id"],
  });
  const config: Config = { rows: { subscriptions: 300 }, seed: 5, until: "2022-01-01" };
  const win = temporalWindow(config);
  let sawFuture = false;
  for (const r of rowsFor(build(schema(subs), config), "public.subscriptions")) {
    const created = timestampMs(r.created_at)!;
    assert.ok(timestampMs(r.last_login)! >= created && timestampMs(r.last_login)! <= win.untilMs);
    const exp = timestampMs(r.expires_at)!;
    assert.ok(exp >= created && exp <= win.futureMs);
    if (exp > win.untilMs) sawFuture = true;
  }
  assert.ok(sawFuture, "expected at least one expiry past `until`");
});

test("date-only columns stay YYYY-MM-DD strings and remain ordered", () => {
  const events = table("events", {
    columns: [
      idCol(),
      col("created_at", { udtName: "date" }),
      col("updated_at", { udtName: "date" }),
    ],
    primaryKey: ["id"],
  });
  for (const r of rowsFor(build(schema(events), { rows: { events: 100 }, seed: 4 }), "public.events")) {
    assert.match(String(r.created_at), /^\d{4}-\d{2}-\d{2}$/);
    assert.match(String(r.updated_at), /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(String(r.updated_at) >= String(r.created_at));
  }
});

test("output stays byte-identical across runs with the same seed", () => {
  const cfg: Config = { rows: { users: 30, orders: 60 }, seed: 11 };
  const a = build(usersAndOrders(), cfg);
  const b = build(usersAndOrders(), cfg);
  assert.deepEqual(JSON.stringify(a), JSON.stringify(b));
});

test("planTemporal picks the first creation column and ignores tables without one", () => {
  const withCreate = table("t", {
    columns: [col("registered_at", { udtName: "timestamptz" }), col("last_seen", { udtName: "timestamptz" })],
  });
  const plan = planTemporal(withCreate);
  assert.equal(plan?.created.name, "registered_at");
  assert.deepEqual(
    plan?.others.map((o) => o.name),
    ["last_seen"],
  );

  const noCreate = table("u", { columns: [col("name", { udtName: "text" })] });
  assert.equal(planTemporal(noCreate), null);
});

test("temporalWindow rejects since after until", () => {
  assert.throws(() => temporalWindow({ since: "2023-01-01", until: "2022-01-01" }), /after --until/);
  assert.throws(() => temporalWindow({ until: "not-a-date" }), /Invalid --until/);
});
