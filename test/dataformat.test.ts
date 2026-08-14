/** Tests for CSV/NDJSON serialization and one-file-per-table output. */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isOutputFormat, tableToCsv, tableToNdjson, writeTableFiles } from "../src/dataformat.js";
import type { TableData } from "../src/generate.js";
import { col, idCol, table } from "./helpers.js";

function td(columns: ReturnType<typeof col>[], rows: Record<string, unknown>[], name = "t"): TableData {
  return { table: table(name, { columns, primaryKey: [] }), columns, rows };
}

// ---- format guard ----

test("isOutputFormat accepts the three known formats and rejects others", () => {
  assert.ok(isOutputFormat("sql"));
  assert.ok(isOutputFormat("csv"));
  assert.ok(isOutputFormat("ndjson"));
  assert.ok(!isOutputFormat("tsv"));
  assert.ok(!isOutputFormat(""));
});

// ---- CSV ----

test("tableToCsv writes a header row then one row per record", () => {
  const data = td([col("id", { udtName: "int4" }), col("email")], [
    { id: 1, email: "a@x.com" },
    { id: 2, email: "b@x.com" },
  ]);
  assert.equal(tableToCsv(data), "id,email\n1,a@x.com\n2,b@x.com\n");
});

test("tableToCsv quotes fields containing comma, quote, or newline", () => {
  const data = td([col("v")], [
    { v: "a,b" },
    { v: 'say "hi"' },
    { v: "line1\nline2" },
  ]);
  assert.equal(tableToCsv(data), 'v\n"a,b"\n"say ""hi"""\n"line1\nline2"\n');
});

test("tableToCsv leaves null/undefined as an empty field", () => {
  const data = td([col("a"), col("b")], [{ a: null, b: undefined }]);
  assert.equal(tableToCsv(data), "a,b\n,\n");
});

test("tableToCsv renders dates as ISO, buffers as base64, booleans as text", () => {
  const data = td([col("d", { udtName: "timestamptz" }), col("bin", { udtName: "bytea" }), col("ok", { udtName: "bool" })], [
    { d: new Date("2025-01-02T03:04:05.000Z"), bin: Buffer.from("AB"), ok: true },
  ]);
  assert.equal(tableToCsv(data), "d,bin,ok\n2025-01-02T03:04:05.000Z,QUI=,true\n");
});

test("tableToCsv encodes arrays and objects as compact JSON, quoted", () => {
  const data = td([col("tags", { udtName: "_text" }), col("meta", { udtName: "jsonb" })], [
    { tags: ["a", "b"], meta: { k: "v,w" } },
  ]);
  assert.equal(tableToCsv(data), 'tags,meta\n"[""a"",""b""]","{""k"":""v,w""}"\n');
});

test("tableToCsv on an empty table is a header-only file", () => {
  assert.equal(tableToCsv(td([col("id"), col("v")], [])), "id,v\n");
});

// ---- NDJSON ----

test("tableToNdjson writes one JSON object per row over the emitted columns", () => {
  const data = td([col("id", { udtName: "int4" }), col("email")], [
    { id: 1, email: "a@x.com" },
    { id: 2, email: "b@x.com" },
  ]);
  assert.equal(tableToNdjson(data), '{"id":1,"email":"a@x.com"}\n{"id":2,"email":"b@x.com"}\n');
});

test("tableToNdjson keeps json arrays/objects native and coerces null", () => {
  const data = td([col("tags", { udtName: "_text" }), col("meta", { udtName: "jsonb" }), col("x")], [
    { tags: ["a", "b"], meta: { k: 1 }, x: undefined },
  ]);
  assert.equal(tableToNdjson(data), '{"tags":["a","b"],"meta":{"k":1},"x":null}\n');
});

test("tableToNdjson renders dates as ISO and buffers (even nested) as base64", () => {
  const data = td([col("d", { udtName: "timestamptz" }), col("meta", { udtName: "jsonb" })], [
    { d: new Date("2025-01-02T03:04:05.000Z"), meta: { blob: Buffer.from("AB") } },
  ]);
  assert.equal(
    tableToNdjson(data),
    '{"d":"2025-01-02T03:04:05.000Z","meta":{"blob":"QUI="}}\n',
  );
});

test("tableToNdjson on an empty table is the empty string", () => {
  assert.equal(tableToNdjson(td([col("id")], [])), "");
});

// ---- writeTableFiles ----

test("writeTableFiles writes one file per non-empty table with the right extension", async () => {
  const dir = await mkdtemp(join(tmpdir(), "seedfmt-"));
  const users = td([idCol(), col("email")], [{ id: 1, email: "a@x.com" }], "users");
  const empty = td([idCol()], [], "empty");
  const res = await writeTableFiles([users, empty], dir, "csv");

  assert.deepEqual(res, { rows: 1, files: 1 });
  assert.deepEqual((await readdir(dir)).sort(), ["users.csv"]);
  assert.equal(await readFile(join(dir, "users.csv"), "utf8"), "id,email\n1,a@x.com\n");
});

test("writeTableFiles qualifies filenames by schema only when a bare name collides", async () => {
  const dir = await mkdtemp(join(tmpdir(), "seedfmt-"));
  const pub = { table: table("users", { schema: "public", columns: [idCol()], primaryKey: [] }), columns: [idCol()], rows: [{ id: 1 }] };
  const auth = { table: table("users", { schema: "auth", columns: [idCol()], primaryKey: [] }), columns: [idCol()], rows: [{ id: 1 }] };
  const solo = td([idCol()], [{ id: 1 }], "orders");
  await writeTableFiles([pub, auth, solo], dir, "ndjson");

  assert.deepEqual(
    (await readdir(dir)).sort(),
    ["auth.users.ndjson", "orders.ndjson", "public.users.ndjson"],
  );
});
