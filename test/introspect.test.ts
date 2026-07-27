/** Tests for the pure type-categorization helper used during introspection. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { categorize } from "../src/introspect.js";

test("enum columns are detected whenever labels are present", () => {
  assert.equal(categorize("order_status", ["a", "b"]), "enum");
  // Enum wins even if the base name would otherwise categorize differently.
  assert.equal(categorize("int4", ["a"]), "enum");
});

test("underscore-prefixed types are arrays", () => {
  assert.equal(categorize("_text", null), "array");
  assert.equal(categorize("_int4", null), "array");
});

test("integer family", () => {
  for (const t of ["int2", "int4", "int8"]) {
    assert.equal(categorize(t, null), "integer");
  }
});

test("decimal family", () => {
  for (const t of ["float4", "float8", "numeric"]) {
    assert.equal(categorize(t, null), "decimal");
  }
});

test("date/time families are distinguished", () => {
  assert.equal(categorize("date", null), "date");
  assert.equal(categorize("time", null), "time");
  assert.equal(categorize("timetz", null), "time");
  assert.equal(categorize("timestamp", null), "timestamp");
  assert.equal(categorize("timestamptz", null), "timestamp");
});

test("scalar special types", () => {
  assert.equal(categorize("bool", null), "boolean");
  assert.equal(categorize("uuid", null), "uuid");
  assert.equal(categorize("bytea", null), "bytea");
  assert.equal(categorize("json", null), "json");
  assert.equal(categorize("jsonb", null), "json");
  assert.equal(categorize("inet", null), "inet");
  assert.equal(categorize("cidr", null), "inet");
});

test("text-like types collapse to text", () => {
  for (const t of ["text", "varchar", "bpchar", "citext", "name"]) {
    assert.equal(categorize(t, null), "text");
  }
});

test("unknown types fall back to text", () => {
  assert.equal(categorize("some_custom_domain", null), "text");
});
