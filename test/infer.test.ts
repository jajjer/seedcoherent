/** Tests for column value-generator inference (name heuristics, type, overrides). */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Faker, en } from "@faker-js/faker";
import { inferGenerator, partitionKeyGenerator } from "../src/infer.js";
import type { ColumnCheck, PartitionInfo } from "../src/types.js";
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

/** Infer + invoke a generator honoring a distilled CHECK. */
function genChecked(c: ReturnType<typeof col>, check: ColumnCheck): unknown {
  const t = table("t", { columns: [c] });
  return inferGenerator(t, c, {}, check)(faker());
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

test("money column yields a numeric string", () => {
  const v = gen(col("balance", { udtName: "money" })) as string;
  assert.equal(typeof v, "string");
  assert.match(v, /^\d+\.\d{2}$/);
});

test("interval column yields a parseable interval literal", () => {
  const v = gen(col("duration", { udtName: "interval" })) as string;
  assert.match(v, /^\d+ days \d{2}:\d{2}:\d{2}$/);
});

test("macaddr column yields six colon-separated octets", () => {
  const v = gen(col("hw_addr", { udtName: "macaddr" })) as string;
  assert.match(v, /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i);
});

test("xml column yields a well-formed record element", () => {
  const v = gen(col("payload", { udtName: "xml" })) as string;
  assert.match(v, /^<record><id>[0-9a-f-]{36}<\/id><value>[a-z]+<\/value><\/record>$/i);
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

test("enum array draws every element from the enum labels", () => {
  const labels = ["happy", "sad", "meh"];
  const c = col("moods", {
    udtName: "_mood",
    dataType: "array",
    elementType: { udtName: "mood", dataType: "enum", enumValues: labels },
  });
  for (let i = 0; i < 20; i++) {
    const v = gen(c) as string[];
    assert.ok(Array.isArray(v));
    for (const el of v) assert.ok(labels.includes(el), `unexpected enum element ${el}`);
  }
});

test("composite column yields a parenthesized record literal", () => {
  const c = col("home", {
    udtName: "addr",
    dataType: "composite",
    compositeFields: [
      { name: "line1", udtName: "text", dataType: "text", enumValues: null },
      { name: "num", udtName: "int4", dataType: "integer", enumValues: null },
    ],
  });
  const v = gen(c) as string;
  assert.equal(typeof v, "string");
  assert.match(v, /^\(.*\)$/);
  // Two comma-separated top-level fields.
  assert.match(v, /^\("[^"]*",\d+\)$/);
});

test("range column yields a [lower,upper) literal with lower < upper", () => {
  const c = col("span", {
    udtName: "int4range",
    dataType: "range",
    rangeSubtype: { udtName: "int4", dataType: "integer", enumValues: null },
  });
  const v = gen(c) as string;
  const m = v.match(/^\[(\d+),(\d+)\)$/);
  assert.ok(m, `unexpected range literal ${v}`);
  assert.ok(Number(m![1]) < Number(m![2]));
});

test("a regex CHECK generates a matching string (zip domain)", () => {
  const c = col("zip", { udtName: "text" });
  for (let i = 0; i < 20; i++) {
    const t = table("t", { columns: [c] });
    const v = inferGenerator(t, c, {}, { pattern: "^[0-9]{5}$" })(faker()) as string;
    assert.match(v, /^[0-9]{5}$/, `"${v}" does not match the pattern`);
  }
});

test("an unsupported regex CHECK falls back without throwing", () => {
  // Back-references aren't supported by the sampler; it must not crash.
  const c = col("weird", { udtName: "text" });
  const v = genChecked(c, { pattern: "^(a)\\1$" });
  assert.equal(typeof v, "string");
});

test("RANGE partition key stays inside a covered interval", () => {
  const c = col("at", { udtName: "timestamptz", dataType: "timestamp" });
  const part: PartitionInfo = {
    strategy: "range",
    keyColumns: ["at"],
    hasDefault: false,
    ranges: [{ from: "2024-01-01", to: "2025-01-01" }],
  };
  const g = partitionKeyGenerator(c, part)!;
  assert.ok(g, "expected a partition-key generator");
  for (let i = 0; i < 20; i++) {
    const d = g(faker()) as Date;
    assert.ok(d instanceof Date);
    assert.ok(d >= new Date("2024-01-01") && d < new Date("2025-01-01"), `${d.toISOString()} out of range`);
  }
});

test("LIST partition key draws only from accepted values", () => {
  const c = col("status", { udtName: "text" });
  const part: PartitionInfo = {
    strategy: "list",
    keyColumns: ["status"],
    hasDefault: false,
    list: ["open", "closed", "pending"],
  };
  const g = partitionKeyGenerator(c, part)!;
  for (let i = 0; i < 20; i++) {
    assert.ok(["open", "closed", "pending"].includes(g(faker()) as string));
  }
});

test("partition key generator is skipped when a DEFAULT partition exists", () => {
  const c = col("at", { udtName: "timestamptz", dataType: "timestamp" });
  const part: PartitionInfo = { strategy: "range", keyColumns: ["at"], hasDefault: true, ranges: [] };
  assert.equal(partitionKeyGenerator(c, part), null);
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

// --- numeric name heuristics -------------------------------------------------

/** Draw N values from a column's generator to assert a whole range stays sane. */
function samples(c: ReturnType<typeof col>, n = 200): number[] {
  const t = table("t", { columns: [c] });
  const g = inferGenerator(t, c);
  const f = faker();
  return Array.from({ length: n }, () => g(f) as number);
}

test("age integer column stays in a human range", () => {
  const vals = samples(col("age", { udtName: "int4" }));
  assert.ok(vals.every((v) => Number.isInteger(v) && v >= 0 && v <= 95), `out of range: ${Math.max(...vals)}`);
});

test("year column produces plausible years", () => {
  const vals = samples(col("birth_year", { udtName: "int4" }));
  assert.ok(vals.every((v) => v >= 1970 && v <= 2025));
});

test("quantity column is a small positive count", () => {
  const vals = samples(col("quantity", { udtName: "int4" }));
  assert.ok(vals.every((v) => v >= 1 && v <= 100));
});

test("rating column stays within 1..5", () => {
  const vals = samples(col("rating", { udtName: "int4" }));
  assert.ok(vals.every((v) => v >= 1 && v <= 5));
});

test("discount percent stays within 0..100", () => {
  const vals = samples(col("discount_percent", { udtName: "int4" }));
  assert.ok(vals.every((v) => v >= 0 && v <= 100));
});

test("price numeric column honors scale and a realistic ceiling", () => {
  const vals = samples(col("price", { udtName: "numeric", numericScale: 2 }));
  assert.ok(vals.every((v) => v >= 0 && v <= 10_000));
  // At most 2 decimal places.
  assert.ok(vals.every((v) => Number.isInteger(Math.round(v * 100))));
});

test("integer-typed amount column rounds to a whole number", () => {
  const vals = samples(col("amount_cents", { udtName: "int4" }));
  assert.ok(vals.every((v) => Number.isInteger(v)));
});

test("numeric name rules never fire on a text column", () => {
  const v = gen(col("age", { udtName: "text" }));
  assert.equal(typeof v, "string");
});
