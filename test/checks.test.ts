/** Tests for parsing normalized Postgres CHECK expressions into column bounds. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseChecks } from "../src/checks.js";
import type { CheckConstraint } from "../src/types.js";

/** Parse one or more raw expressions and return the merged column map. */
function parse(...exprs: string[]): ReturnType<typeof parseChecks> {
  const checks: CheckConstraint[] = exprs.map((expr) => ({ expr }));
  return parseChecks(checks);
}

test("greater-than with a numeric cast yields an exclusive lower bound", () => {
  // CHECK (price > 0) on a numeric column.
  const c = parse("(price > (0)::numeric)").get("price");
  assert.deepEqual(c, { min: 0, minExclusive: true });
});

test("plain >= yields an inclusive lower bound", () => {
  const c = parse("(age >= 0)").get("age");
  assert.deepEqual(c, { min: 0, minExclusive: false });
});

test("a range across a top-level AND merges into min and max", () => {
  // CHECK (age >= 0 AND age <= 120) — Postgres parenthesizes each conjunct.
  const c = parse("((age >= 0) AND (age <= 120))").get("age");
  assert.equal(c?.min, 0);
  assert.equal(c?.max, 120);
  assert.equal(c?.maxExclusive, false);
});

test("flipped operand order is normalized", () => {
  // CHECK (0 < qty) reads as qty > 0.
  const c = parse("((0)::numeric < qty)").get("qty");
  assert.deepEqual(c, { min: 0, minExclusive: true });
});

test("membership becomes an allowed value set (text column)", () => {
  const c = parse("(status = ANY (ARRAY['active'::text, 'inactive'::text]))").get("status");
  assert.deepEqual(c?.in, ["active", "inactive"]);
});

test("membership handles the varchar cast form", () => {
  const c = parse(
    "((status)::text = ANY (ARRAY['a'::character varying, 'b'::character varying]::text[]))",
  ).get("status");
  assert.deepEqual(c?.in, ["a", "b"]);
});

test("numeric membership sets are parsed as numbers", () => {
  const c = parse("(rating = ANY (ARRAY[1, 2, 3, 4, 5]))").get("rating");
  assert.deepEqual(c?.in, [1, 2, 3, 4, 5]);
});

test("char_length lower bound becomes minLength", () => {
  const c = parse("(char_length((name)::text) >= 3)").get("name");
  assert.deepEqual(c, { minLength: 3 });
});

test("length upper bound becomes maxLength", () => {
  const c = parse("(length(code) <= 8)").get("code");
  assert.deepEqual(c, { maxLength: 8 });
});

test("tightest bound wins when multiple checks touch one column", () => {
  const c = parse("(n >= 0)", "(n >= 10)", "(n <= 100)", "(n <= 50)").get("n");
  assert.equal(c?.min, 10);
  assert.equal(c?.max, 50);
});

test("membership sets intersect across constraints", () => {
  const c = parse(
    "(s = ANY (ARRAY['a'::text, 'b'::text, 'c'::text]))",
    "(s = ANY (ARRAY['b'::text, 'c'::text, 'd'::text]))",
  ).get("s");
  assert.deepEqual(c?.in, ["b", "c"]);
});

test("a regex match becomes a pattern bound (domain CHECK shape)", () => {
  // A domain CHECK (VALUE ~ '^[0-9]{5}$') is rewritten to reference the column.
  const c = parse(`(("zip")::text ~ '^[0-9]{5}$'::text)`).get("zip");
  assert.equal(c?.pattern, "^[0-9]{5}$");
});

test("case-insensitive regex (~*) is parsed too", () => {
  const c = parse(`((code)::text ~* '^[a-z]+$'::text)`).get("code");
  assert.equal(c?.pattern, "^[a-z]+$");
});

test("unparseable expressions are ignored, not guessed", () => {
  // A function-call predicate we don't understand should produce no bound.
  const map = parse("(lower((email)::text) ~~ '%@example.com'::text)");
  assert.equal(map.size, 0);
});

test("not-equal comparisons produce no usable range bound", () => {
  const map = parse("(status <> 'deleted'::text)");
  // No numeric bound; the clause is simply dropped.
  assert.equal(map.get("status")?.min, undefined);
  assert.equal(map.get("status")?.max, undefined);
});
