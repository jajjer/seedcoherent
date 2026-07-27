/** Tests for column value-generator inference (name heuristics, type, overrides). */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Faker, en } from "@faker-js/faker";
import { inferGenerator } from "../src/infer.js";
import { col, table } from "./helpers.js";

/** A fresh, seeded Faker so any randomness in assertions is stable. */
function faker(): Faker {
  const f = new Faker({ locale: [en] });
  f.seed(1);
  return f;
}

/** Infer + invoke a generator for a standalone column. */
function gen(c: ReturnType<typeof col>, overrides = {}): unknown {
  const t = table("t", { columns: [c] });
  return inferGenerator(t, c, overrides)(faker());
}

test("email column produces an email address", () => {
  const v = gen(col("email"));
  assert.equal(typeof v, "string");
  assert.match(v as string, /@/);
});

test("first_name column produces a non-empty string", () => {
  const v = gen(col("first_name"));
  assert.equal(typeof v, "string");
  assert.ok((v as string).length > 0);
});

test("camelCase names are tokenized (shippingCity -> city)", () => {
  const v = gen(col("shippingCity"));
  assert.equal(typeof v, "string");
  assert.ok((v as string).length > 0);
});

test("enum column always draws from its labels, ignoring the name", () => {
  const labels = ["draft", "sent", "paid"];
  // Named "email" to prove enum handling wins over name heuristics.
  const c = col("email", { udtName: "order_status", dataType: "enum", enumValues: labels });
  for (let i = 0; i < 20; i++) {
    assert.ok(labels.includes(gen(c) as string));
  }
});

test("name heuristic is skipped when the column type is incompatible", () => {
  // "phone" would yield a string, but an integer column must get a number.
  const v = gen(col("phone", { udtName: "int4" }));
  assert.equal(typeof v, "number");
});

test("boolean column yields a boolean", () => {
  const v = gen(col("is_active", { udtName: "bool" }));
  assert.equal(typeof v, "boolean");
});

test("uuid column yields a uuid string", () => {
  const v = gen(col("token", { udtName: "uuid" }));
  assert.match(v as string, /^[0-9a-f-]{36}$/i);
});

test("decimal respects numeric scale", () => {
  const c = col("ratio", { udtName: "numeric", numericScale: 3 });
  const v = gen(c) as number;
  assert.equal(typeof v, "number");
  const decimals = (String(v).split(".")[1] ?? "").length;
  assert.ok(decimals <= 3, `expected <=3 decimals, got ${v}`);
});

test("varchar(n) length limit truncates generic text output", () => {
  const c = col("code", { udtName: "varchar", maxLength: 4 });
  // "code" matches no name rule, so it falls back to the length-aware text gen.
  for (let i = 0; i < 20; i++) {
    const v = inferGenerator(table("t", { columns: [c] }), c)(faker()) as string;
    assert.ok(v.length <= 4, `"${v}" exceeds max length 4`);
  }
});

test("array column yields an array", () => {
  const v = gen(col("tags", { udtName: "_text" }));
  assert.ok(Array.isArray(v));
});

test("string override resolves a faker path", () => {
  const v = gen(col("whatever"), { whatever: "internet.email" });
  assert.match(v as string, /@/);
});

test("{ faker } override resolves a faker path", () => {
  const v = gen(col("whatever"), { whatever: { faker: "person.firstName" } });
  assert.equal(typeof v, "string");
});

test("{ value } override returns the fixed value", () => {
  assert.equal(gen(col("whatever"), { whatever: { value: 42 } }), 42);
});

test("{ values } override picks from the list", () => {
  const v = gen(col("whatever"), { whatever: { values: ["x", "y", "z"] } });
  assert.ok(["x", "y", "z"].includes(v as string));
});

test("qualified table.column override beats a bare column override", () => {
  const c = col("email");
  const t = table("users", { columns: [c] });
  const v = inferGenerator(t, c, {
    email: { value: "bare" },
    "users.email": { value: "qualified" },
  })(faker());
  assert.equal(v, "qualified");
});

test("invalid faker path throws when invoked", () => {
  const c = col("x");
  const g = inferGenerator(table("t", { columns: [c] }), c, { x: "not.a.real.path" });
  assert.throws(() => g(faker()), /Invalid faker path/);
});
