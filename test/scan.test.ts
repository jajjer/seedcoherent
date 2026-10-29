/** Tests for the --scan pre-copy privacy report: classification + action, drift. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { topoSort } from "../src/graph.js";
import type { Row } from "../src/generate.js";
import {
  anonymizeAll,
  formatScanReport,
  scanSubset,
  type ScanColumn,
} from "../src/subset.js";
import { col, fk, idCol, schema, table } from "./helpers.js";
import type { Config, Schema } from "../src/types.js";

/**
 * users (id PK) <- orders (user_id FK) and a standalone contacts table whose
 * primary key is an email — the classic "PII used as a key" case.
 */
function fixture(): Schema {
  const users = table("users", {
    columns: [idCol(), col("full_name"), col("country"), col("ssn")],
    primaryKey: ["id"],
  });
  const orders = table("orders", {
    columns: [
      idCol(),
      col("user_id", { udtName: "int4" }),
      col("note", { nullable: true }),
    ],
    primaryKey: ["id"],
    foreignKeys: [fk(["user_id"], "users", ["id"])],
  });
  const contacts = table("contacts", {
    columns: [col("email"), col("label")],
    primaryKey: ["email"],
  });
  return schema(users, orders, contacts);
}

const find = (rows: ScanColumn[], t: string, c: string): ScanColumn =>
  rows.find((r) => r.table === `public.${t}` && r.column === c)!;

test("scanSubset classifies every column with its PII category and action", () => {
  const rows = scanSubset(fixture(), {});
  const f = (t: string, c: string) => find(rows, t, c);

  // Keys pass through verbatim.
  assert.equal(f("users", "id").action, "key");
  assert.equal(f("users", "id").category, null);
  assert.equal(f("orders", "user_id").action, "key"); // FK column
  assert.equal(f("orders", "id").action, "key");

  // An email primary key is a key — copied UNCHANGED despite being PII.
  assert.equal(f("contacts", "email").action, "key");
  assert.equal(f("contacts", "email").category, "email");

  // Non-key columns scrub by default.
  assert.equal(f("users", "full_name").action, "scrub");
  assert.equal(f("users", "full_name").category, "person_name");
  assert.equal(f("users", "country").action, "scrub");
  assert.equal(f("users", "country").category, "geo");
  assert.equal(f("users", "ssn").action, "scrub");
  assert.equal(f("users", "ssn").category, "ssn");
  assert.equal(f("orders", "note").action, "scrub");
  assert.equal(f("contacts", "label").action, "scrub");
  assert.equal(f("contacts", "label").category, null);

  // Stable sort: by table key, then column.
  assert.deepEqual(
    rows.map((r) => `${r.table}.${r.column}`),
    [
      "public.contacts.email",
      "public.contacts.label",
      "public.orders.id",
      "public.orders.note",
      "public.orders.user_id",
      "public.users.country",
      "public.users.full_name",
      "public.users.id",
      "public.users.ssn",
    ],
  );
});

test("--preserve keeps a column verbatim; PII is still reported", () => {
  const rows = scanSubset(fixture(), { preserve: ["users.country"] });
  const c = find(rows, "users", "country");
  assert.equal(c.action, "keep");
  assert.equal(c.category, "geo"); // still flagged — a preserved PII leak
});

test("--anonymize scrubs a standalone key column", () => {
  const rows = scanSubset(fixture(), { anonymize: ["contacts.email"] });
  assert.equal(find(rows, "contacts", "email").action, "scrub");
});

test("--anonymize a join key scrubs the whole group consistently", () => {
  const rows = scanSubset(fixture(), { anonymize: ["users.id"] });
  assert.equal(find(rows, "users", "id").action, "scrub");
  assert.equal(find(rows, "orders", "user_id").action, "scrub");
});

test("scan actions match anonymizeAll: key/keep columns pass through unchanged", () => {
  const s = fixture();
  const { order } = topoSort(s);
  const config: Config = { seed: 1, preserve: ["users.country"] };
  const selected = new Map<string, Row[]>([
    [
      "public.users",
      [{ id: 1, full_name: "Jane Doe", country: "US", ssn: "111-22-3333" }],
    ],
    ["public.orders", [{ id: 7, user_id: 1, note: "hi" }]],
    ["public.contacts", [{ email: "a@b.com", label: "home" }]],
  ]);

  const data = anonymizeAll(s, order, selected, config);
  const rows = scanSubset(s, config);

  for (const td of data) {
    for (const c of td.columns) {
      const sc = find(rows, td.table.name, c.name);
      const before = selected.get(td.table.key)![0][c.name];
      const after = td.rows[0][c.name];
      if (sc.action === "key" || sc.action === "keep") {
        assert.deepEqual(
          after,
          before,
          `${td.table.key}.${c.name} (${sc.action}) should pass through unchanged`,
        );
      }
    }
  }

  // Sanity: a scrubbed column really changed.
  const users = data.find((d) => d.table.name === "users")!;
  assert.notDeepEqual(users.rows[0].full_name, "Jane Doe");
});

test("formatScanReport marks PII copied verbatim and summarizes", () => {
  const rows = scanSubset(fixture(), { preserve: ["users.country"] });
  const out = formatScanReport(rows);
  assert.match(out, /contacts\.email/);
  assert.match(out, /⚠/); // email PK and preserved country both leak
  assert.match(out, /2 PII copied verbatim ⚠/);
  assert.match(out, /9 columns · \d+ PII/);
});
