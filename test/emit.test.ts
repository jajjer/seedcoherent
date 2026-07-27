/** Tests for SQL-literal formatting and full-script generation. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { sqlLiteral, toSql } from "../src/emit.js";
import type { TableData } from "../src/generate.js";
import { col, idCol, table } from "./helpers.js";

const textCol = col("v", { udtName: "text" });
const jsonCol = col("v", { udtName: "jsonb" });

test("null and undefined become NULL", () => {
  assert.equal(sqlLiteral(null, textCol), "NULL");
  assert.equal(sqlLiteral(undefined, textCol), "NULL");
});

test("booleans become TRUE/FALSE", () => {
  assert.equal(sqlLiteral(true, textCol), "TRUE");
  assert.equal(sqlLiteral(false, textCol), "FALSE");
});

test("numbers are emitted unquoted", () => {
  assert.equal(sqlLiteral(42, textCol), "42");
  assert.equal(sqlLiteral(3.14, textCol), "3.14");
});

test("dates become quoted ISO strings", () => {
  const d = new Date("2025-01-02T03:04:05.000Z");
  assert.equal(sqlLiteral(d, textCol), "'2025-01-02T03:04:05.000Z'");
});

test("buffers become bytea hex literals", () => {
  assert.equal(sqlLiteral(Buffer.from("AB"), col("b", { udtName: "bytea" })), "'\\x4142'");
});

test("arrays become Postgres array literals with quoted elements", () => {
  assert.equal(sqlLiteral(["a", "b"], col("t", { udtName: "_text" })), `'{"a","b"}'`);
});

test("array elements with quotes/backslashes are escaped", () => {
  assert.equal(sqlLiteral(['a"b', "c\\d"], col("t", { udtName: "_text" })), `'{"a\\"b","c\\\\d"}'`);
});

test("objects and json columns are JSON-encoded and cast to jsonb", () => {
  assert.equal(sqlLiteral({ a: 1 }, jsonCol), `'{"a":1}'::jsonb`);
});

test("single quotes in strings are doubled", () => {
  assert.equal(sqlLiteral("O'Brien", textCol), "'O''Brien'");
});

test("single quotes inside json are doubled", () => {
  assert.equal(sqlLiteral({ name: "O'Brien" }, jsonCol), `'{"name":"O''Brien"}'::jsonb`);
});

// ---- toSql script assembly ----

function usersData(): TableData {
  const t = table("users", {
    columns: [idCol(), col("email")],
    primaryKey: ["id"],
  });
  return {
    table: t,
    columns: t.columns,
    rows: [
      { id: 1, email: "a@x.com" },
      { id: 2, email: "b@x.com" },
    ],
  };
}

test("toSql wraps output in a transaction", () => {
  const sql = toSql([usersData()]);
  assert.ok(sql.startsWith("BEGIN;"));
  assert.ok(sql.trimEnd().endsWith("COMMIT;"));
});

test("toSql emits an INSERT with a quoted, schema-qualified target", () => {
  const sql = toSql([usersData()]);
  assert.match(sql, /INSERT INTO "public"\."users" \("id", "email"\)/);
});

test("toSql uses OVERRIDING SYSTEM VALUE for identity PKs we assign", () => {
  const sql = toSql([usersData()]);
  assert.match(sql, /OVERRIDING SYSTEM VALUE/);
});

test("toSql resets the sequence for identity PKs", () => {
  const sql = toSql([usersData()]);
  assert.match(sql, /setval\(pg_get_serial_sequence\('public\.users', 'id'\)/);
});

test("toSql skips tables with zero rows", () => {
  const empty: TableData = {
    table: table("empty", { columns: [idCol()], primaryKey: ["id"] }),
    columns: [idCol()],
    rows: [],
  };
  const sql = toSql([empty]);
  assert.doesNotMatch(sql, /INSERT INTO/);
});
