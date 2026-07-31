/**
 * Columns of a type we can't generate a valid literal for (money, interval,
 * tsvector, geometry, …) must never get lorem text stuffed into them — that
 * fails the INSERT and rolls back the whole run. Instead we NULL/skip what we
 * safely can and flag the rest up front.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildData, requiredUnsupportedColumns } from "../src/generate.js";
import { topoSort } from "../src/graph.js";
import { col, fk, idCol, schema, table } from "./helpers.js";
import type { Config } from "../src/types.js";

function gen(s: ReturnType<typeof schema>, config: Config) {
  const { order, cyclic } = topoSort(s);
  return buildData(s, order, cyclic, config);
}

test("categorize routes an unknown udtName to the unsupported category", () => {
  // helpers.col derives dataType via categorize() when not given explicitly.
  assert.equal(col("g", { udtName: "geometry" }).dataType, "unsupported");
});

test("requiredUnsupportedColumns flags a NOT NULL unsupported column", () => {
  const t = table("docs", {
    columns: [idCol(), col("geom", { udtName: "geometry" })],
    primaryKey: ["id"],
  });
  const bad = requiredUnsupportedColumns(schema(t), {}, ["public.docs"]);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].column, "geom");
  assert.equal(bad[0].udtName, "geometry");
});

test("nullable / defaulted / overridden / FK-served columns are not flagged", () => {
  const t = table("docs", {
    columns: [
      idCol(),
      col("a", { udtName: "geometry", nullable: true }),
      col("b", { udtName: "geometry", hasDefault: true }),
      col("c", { udtName: "geometry" }),
      col("d", { udtName: "geometry" }),
    ],
    primaryKey: ["id"],
    // A (contrived) FK makes `d` draw its value from a parent row.
    foreignKeys: [fk(["d"], "docs", ["c"])],
  });
  const config: Config = { columns: { "docs.c": "internet.url" } };
  const bad = requiredUnsupportedColumns(schema(t), config, ["public.docs"]);
  assert.deepEqual(bad, []);
});

test("generation NULLs a nullable unsupported column and omits a defaulted one", () => {
  const t = table("docs", {
    columns: [
      idCol(),
      col("shape", { udtName: "geometry", nullable: true }),
      col("area", { udtName: "geometry", hasDefault: true }),
    ],
    primaryKey: ["id"],
  });
  const [d] = gen(schema(t), { defaultRows: 3, seed: 1 });
  // `area` is left out of the INSERT so the DB supplies its default.
  assert.deepEqual(
    d.columns.map((c) => c.name),
    ["id", "shape"],
  );
  assert.equal(d.rows.length, 3);
  for (const r of d.rows) assert.equal(r.shape, null);
});

test("an override fills an unsupported column instead of NULL", () => {
  const t = table("docs", {
    columns: [idCol(), col("shape", { udtName: "geometry" })],
    primaryKey: ["id"],
  });
  const config: Config = { defaultRows: 2, seed: 1, columns: { "docs.shape": { value: "POINT(0 0)" } } };
  const [d] = gen(schema(t), config);
  assert.ok(d.columns.some((c) => c.name === "shape"));
  for (const r of d.rows) assert.equal(r.shape, "POINT(0 0)");
});
