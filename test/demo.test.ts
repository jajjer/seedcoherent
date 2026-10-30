/**
 * Tests the bundled `--demo` schema. The CLI itself isn't spawnable (it exports
 * nothing), so these exercise the same modules the --demo path runs: parse the
 * bundled DDL, generate against it, and prove the result is referentially
 * correct by loading it into an in-memory SQLite DB with FK + CHECK enforcement
 * on. Also checks the sample-rows plan that --demo prints.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { DEMO_SCHEMA_DDL, DEMO_SCHEMA_DIALECT } from "../src/demo.js";
import { loadSchemaFromDdl } from "../src/schema-file.js";
import { topoSort } from "../src/graph.js";
import { buildData } from "../src/generate.js";
import { buildPlan, formatPlan } from "../src/plan.js";
import { toSqlSqlite } from "../src/sqlite-emit.js";

const DEMO_TABLES = [
  "categories",
  "users",
  "products",
  "orders",
  "order_items",
];

const count = (db: Database.Database, sql: string) =>
  Number((db.prepare(sql).get() as any).n);

test("the bundled demo DDL parses into the expected tables", () => {
  const schema = loadSchemaFromDdl(DEMO_SCHEMA_DDL, DEMO_SCHEMA_DIALECT);
  assert.equal(schema.tables.size, DEMO_TABLES.length);
  const names = new Set([...schema.tables.values()].map((t) => t.name));
  for (const name of DEMO_TABLES) {
    assert.ok(names.has(name), `expected table ${name}`);
  }
});

test("--demo generates referentially-correct, constraint-valid rows", () => {
  const schema = loadSchemaFromDdl(DEMO_SCHEMA_DDL, DEMO_SCHEMA_DIALECT);
  const { order, cyclic } = topoSort(schema);
  const data = buildData(schema, order, cyclic, { seed: 42 });

  // Load the generated script into a fresh DB with FK + CHECK enforcement on;
  // any orphan, broken enum, or out-of-range value would throw here.
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(DEMO_SCHEMA_DDL);
  db.exec(toSqlSqlite(data));

  for (const name of DEMO_TABLES) {
    assert.ok(count(db, `SELECT count(*) n FROM ${name}`) > 0, `${name} empty`);
  }

  // Zero orphans across every foreign key.
  assert.equal(
    count(
      db,
      "SELECT count(*) n FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE c.id IS NULL",
    ),
    0,
  );
  assert.equal(
    count(
      db,
      "SELECT count(*) n FROM orders o LEFT JOIN users u ON u.id=o.user_id WHERE u.id IS NULL",
    ),
    0,
  );
  assert.equal(
    count(
      db,
      "SELECT count(*) n FROM order_items i LEFT JOIN orders o ON o.id=i.order_id WHERE o.id IS NULL",
    ),
    0,
  );
  assert.equal(
    count(
      db,
      "SELECT count(*) n FROM order_items i LEFT JOIN products p ON p.id=i.product_id WHERE p.id IS NULL",
    ),
    0,
  );
  // Self-referential parent_id either null or a real category.
  assert.equal(
    count(
      db,
      "SELECT count(*) n FROM categories c LEFT JOIN categories p ON p.id=c.parent_id WHERE c.parent_id IS NOT NULL AND p.id IS NULL",
    ),
    0,
  );

  // CHECK bounds held: enum membership and the numeric ranges.
  assert.equal(
    count(
      db,
      "SELECT count(*) n FROM orders WHERE status NOT IN ('pending','paid','shipped','delivered','cancelled')",
    ),
    0,
  );
  assert.equal(
    count(db, "SELECT count(*) n FROM products WHERE NOT (price > 0)"),
    0,
  );
  assert.equal(
    count(db, "SELECT count(*) n FROM order_items WHERE NOT (quantity > 0)"),
    0,
  );
  // UNIQUE held.
  assert.equal(
    count(db, "SELECT count(*)-count(DISTINCT email) n FROM users"),
    0,
  );
  assert.equal(
    count(db, "SELECT count(*)-count(DISTINCT slug) n FROM categories"),
    0,
  );

  db.close();
});

test("--demo renders a sample-rows plan naming every table", () => {
  const schema = loadSchemaFromDdl(DEMO_SCHEMA_DDL, DEMO_SCHEMA_DIALECT);
  const { order, cyclic } = topoSort(schema);
  const text = formatPlan(buildPlan(schema, order, cyclic, { seed: 42 }));
  assert.match(text, /Sample rows:/);
  for (const name of DEMO_TABLES) {
    assert.ok(text.includes(name), `plan should mention ${name}`);
  }
});
