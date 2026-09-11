/** Tests for status coherence: event-marker timestamps agreeing with a status column. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildData } from "../src/generate.js";
import { topoSort } from "../src/graph.js";
import { planStatus } from "../src/status.js";
import { parseChecks } from "../src/checks.js";
import { temporalWindow, timestampMs } from "../src/temporal.js";
import { col, idCol, schema, table } from "./helpers.js";
import type { CheckConstraint, Config, Schema } from "../src/types.js";

function build(s: Schema, config: Config) {
  const { order, cyclic } = topoSort(s);
  return buildData(s, order, cyclic, config);
}

function rowsFor(data: ReturnType<typeof build>, key: string) {
  const td = data.find((d) => d.table.key === key);
  assert.ok(td, `expected data for ${key}`);
  return td.rows;
}

/** orders(id, status enum, created_at, shipped_at?, delivered_at?, cancelled_at?). */
function ordersSchema(): Schema {
  const orders = table("orders", {
    columns: [
      idCol(),
      col("status", {
        udtName: "order_status",
        enumValues: ["pending", "shipped", "delivered", "cancelled"],
      }),
      col("created_at", { udtName: "timestamptz" }),
      col("shipped_at", { udtName: "timestamptz", nullable: true }),
      col("delivered_at", { udtName: "timestamptz", nullable: true }),
      col("cancelled_at", { udtName: "timestamptz", nullable: true }),
    ],
    primaryKey: ["id"],
  });
  return schema(orders);
}

test("markers agree with status: set at/before the current state, null after", () => {
  const config: Config = { rows: { orders: 500 }, seed: 1 };
  const win = temporalWindow(config);
  const seen = new Set<string>();
  for (const r of rowsFor(build(ordersSchema(), config), "public.orders")) {
    const status = r.status as string;
    seen.add(status);
    const created = timestampMs(r.created_at)!;
    const setAndValid = (v: unknown) => {
      assert.notEqual(v, null, `${status}: marker unexpectedly null`);
      const ms = timestampMs(v)!;
      assert.ok(ms >= created && ms <= win.untilMs, `${status}: marker ${v} outside [created, until]`);
    };
    if (status === "pending") {
      assert.equal(r.shipped_at, null);
      assert.equal(r.delivered_at, null);
      assert.equal(r.cancelled_at, null);
    } else if (status === "shipped") {
      setAndValid(r.shipped_at);
      assert.equal(r.delivered_at, null); // not reached yet
      assert.equal(r.cancelled_at, null); // branch state didn't happen
    } else if (status === "delivered") {
      setAndValid(r.shipped_at); // an earlier progress state
      setAndValid(r.delivered_at);
      // Progress markers run in lifecycle order: shipped before delivered.
      assert.ok(
        timestampMs(r.shipped_at)! <= timestampMs(r.delivered_at)!,
        `delivered_at ${r.delivered_at} precedes shipped_at ${r.shipped_at}`,
      );
      assert.equal(r.cancelled_at, null);
    } else if (status === "cancelled") {
      setAndValid(r.cancelled_at);
      // progress markers are left as generated on a branch state — no assertion.
    }
  }
  // The seed must actually exercise every branch for the assertions to mean something.
  assert.deepEqual([...seen].sort(), ["cancelled", "delivered", "pending", "shipped"]);
});

test("a NOT NULL marker that should be absent is left as-is (can't be nulled)", () => {
  const orders = table("orders", {
    columns: [
      idCol(),
      col("status", { udtName: "st", enumValues: ["pending", "shipped"] }),
      col("created_at", { udtName: "timestamptz" }),
      col("shipped_at", { udtName: "timestamptz", nullable: false }),
    ],
    primaryKey: ["id"],
  });
  // No throw, and every row still carries a shipped_at (NOT NULL can't be cleared),
  // including pending rows where status coherence would otherwise clear it.
  for (const r of rowsFor(build(schema(orders), { rows: { orders: 100 }, seed: 4 }), "public.orders")) {
    assert.notEqual(r.shipped_at, null);
  }
});

test("a --column override on a marker is left untouched", () => {
  // A non-nullable marker so the pinned literal always applies; status coherence
  // must not overwrite it, even on rows whose status would otherwise clear it.
  const orders = table("orders", {
    columns: [
      idCol(),
      col("status", { udtName: "st", enumValues: ["pending", "shipped"] }),
      col("created_at", { udtName: "timestamptz" }),
      col("shipped_at", { udtName: "timestamptz", nullable: false }),
    ],
    primaryKey: ["id"],
  });
  const config: Config = {
    rows: { orders: 200 },
    seed: 2,
    columns: { "orders.shipped_at": { value: "1999-01-01T00:00:00.000Z" } },
  };
  for (const r of rowsFor(build(schema(orders), config), "public.orders")) {
    assert.equal(r.shipped_at, "1999-01-01T00:00:00.000Z");
  }
});

test("output stays byte-identical across runs with the same seed", () => {
  const cfg: Config = { rows: { orders: 120 }, seed: 11 };
  const a = build(ordersSchema(), cfg);
  const b = build(ordersSchema(), cfg);
  assert.deepEqual(JSON.stringify(a), JSON.stringify(b));
});

test("a CHECK (status IN (...)) domain drives the same coherence", () => {
  const checks: CheckConstraint[] = [
    { expr: "((status)::text = ANY (ARRAY['open'::text, 'closed'::text]))" },
  ];
  const tickets = table("tickets", {
    columns: [
      idCol(),
      col("status", { udtName: "text" }),
      col("created_at", { udtName: "timestamptz" }),
      col("closed_at", { udtName: "timestamptz", nullable: true }),
    ],
    primaryKey: ["id"],
    checks,
  });
  const win = temporalWindow({ seed: 8 });
  const seen = new Set<string>();
  for (const r of rowsFor(build(schema(tickets), { rows: { tickets: 300 }, seed: 8 }), "public.tickets")) {
    seen.add(r.status as string);
    if (r.status === "open") {
      assert.equal(r.closed_at, null);
    } else if (r.status === "closed") {
      const ms = timestampMs(r.closed_at)!;
      assert.ok(ms >= timestampMs(r.created_at)! && ms <= win.untilMs);
    }
  }
  assert.deepEqual([...seen].sort(), ["closed", "open"]);
});

test("planStatus needs a bounded status column with a matching marker", () => {
  const noChecks = new Map();
  // No status column at all.
  assert.equal(
    planStatus(table("t", { columns: [col("name"), col("created_at", { udtName: "timestamptz" })] }), noChecks),
    null,
  );
  // A status column but a free-text (unbounded) domain — nothing to key markers off.
  assert.equal(
    planStatus(
      table("t", { columns: [col("status"), col("shipped_at", { udtName: "timestamptz" })] }),
      noChecks,
    ),
    null,
  );
  // Bounded status but no marker column matching any label.
  assert.equal(
    planStatus(
      table("t", {
        columns: [col("status", { udtName: "s", enumValues: ["a", "b"] }), col("note")],
      }),
      noChecks,
    ),
    null,
  );
  // Bounded status with a matching marker → a plan.
  const t = table("t", {
    columns: [
      col("status", { udtName: "s", enumValues: ["pending", "shipped"] }),
      col("shipped_at", { udtName: "timestamptz", nullable: true }),
    ],
  });
  const plan = planStatus(t, parseChecks(t.checks));
  assert.ok(plan);
  assert.deepEqual(plan.progress, ["pending", "shipped"]);
  assert.deepEqual(plan.markers.get("shipped")?.map((m) => m.column), ["shipped_at"]);
});
