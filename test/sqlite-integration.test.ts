/**
 * End-to-end SQLite pipeline test. Unlike the Postgres integration test this
 * needs no external server — better-sqlite3 runs in-process against an in-memory
 * database, so it always runs as part of `npm test`. It exercises the full
 * introspect → sort → generate → insert path and verifies referential
 * integrity, uniqueness, and CHECK bounds directly in the database.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { introspectSqlite } from "../src/sqlite-introspect.js";
import { SqliteSink, insertDataSqlite, toSqlSqlite } from "../src/sqlite-emit.js";
import { SqliteRowFetcher } from "../src/sqlite-subset.js";
import { topoSort } from "../src/graph.js";
import { buildData, generateInto } from "../src/generate.js";
import { anonymizeAll, collectSubset } from "../src/subset.js";
import type { Connection } from "../src/types.js";

const SCHEMA_DDL = `
  PRAGMA foreign_keys=ON;
  CREATE TABLE users (
    id         INTEGER PRIMARY KEY,
    email      TEXT NOT NULL UNIQUE,
    full_name  TEXT NOT NULL,
    role       TEXT NOT NULL CHECK (role IN ('admin','member','guest')),
    created_at DATETIME NOT NULL
  );
  CREATE TABLE orders (
    id      INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    status  TEXT NOT NULL CHECK (status IN ('pending','paid','shipped')),
    total   DECIMAL(10,2) NOT NULL CHECK (total > 0)
  );
  CREATE TABLE order_items (
    order_id INTEGER NOT NULL REFERENCES orders(id),
    line_no  INTEGER NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity >= 1 AND quantity <= 100),
    PRIMARY KEY (order_id, line_no)
  );
`;

/** Fresh in-memory DB with the fixture schema, wrapped as our async Connection. */
function freshDb(): { db: Database.Database; conn: Connection } {
  const db = new Database(":memory:");
  db.exec(SCHEMA_DDL);
  const conn: Connection = {
    async query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
      const stmt = db.prepare(sql);
      const args = (params ?? []) as unknown[];
      if (stmt.reader) return { rows: stmt.all(...args) as T[] };
      stmt.run(...args);
      return { rows: [] };
    },
    async end() {},
  };
  return { db, conn };
}

const ROWS = { users: 20, orders: 60, order_items: 150 };
const count = (db: Database.Database, sql: string) => Number((db.prepare(sql).get() as any).n);

/** Assert the generated data is referentially correct and constraint-valid. */
function assertValid(db: Database.Database) {
  assert.equal(count(db, "SELECT count(*) n FROM users"), 20);
  assert.equal(count(db, "SELECT count(*) n FROM orders"), 60);
  assert.equal(count(db, "SELECT count(*) n FROM order_items"), 150);

  // Zero orphans across a simple and a composite FK.
  assert.equal(
    count(db, "SELECT count(*) n FROM orders o LEFT JOIN users u ON u.id=o.user_id WHERE u.id IS NULL"),
    0,
  );
  assert.equal(
    count(db, "SELECT count(*) n FROM order_items i LEFT JOIN orders o ON o.id=i.order_id WHERE o.id IS NULL"),
    0,
  );

  // Email uniqueness held.
  assert.equal(count(db, "SELECT count(*)-count(DISTINCT email) n FROM users"), 0);

  // CHECK bounds held: enum-like IN sets and the numeric ranges.
  assert.equal(count(db, "SELECT count(*) n FROM users WHERE role NOT IN ('admin','member','guest')"), 0);
  assert.equal(count(db, "SELECT count(*) n FROM orders WHERE NOT (total > 0)"), 0);
  assert.equal(count(db, "SELECT count(*) n FROM order_items WHERE quantity < 1 OR quantity > 100"), 0);
}

test("generateInto streams referentially-correct data into a live SQLite DB", async () => {
  const { db, conn } = freshDb();
  const schema = await introspectSqlite(conn, ["main"]);
  assert.equal(schema.tables.size, 3);

  const { order, cyclic } = topoSort(schema);
  assert.equal(cyclic.size, 0);

  const tables = order;
  const sink = new SqliteSink(conn, { truncate: true, tables }, 16); // small batch → many flushes
  const stats = await generateInto(schema, order, cyclic, { rows: ROWS, seed: 42 }, sink, 16);

  assert.equal(sink.inserted, 230);
  assert.equal(new Map(stats.map((s) => [s.table.name, s.rows])).get("users"), 20);
  assertValid(db);

  // Explicit rowid ids were inserted; SQLite still advances its own counter, so
  // a subsequent DB-assigned insert must not collide.
  const info = db.prepare("INSERT INTO users (email, full_name, role, created_at) VALUES (?,?,?,?)").run(
    "post@example.com",
    "Post",
    "guest",
    "2025-01-01T00:00:00.000Z",
  );
  assert.ok(Number(info.lastInsertRowid) > 20);
  db.close();
});

test("toSqlSqlite emits a script that loads the same data", async () => {
  const { db, conn } = freshDb();
  const schema = await introspectSqlite(conn, ["main"]);
  const { order, cyclic } = topoSort(schema);
  const data = buildData(schema, order, cyclic, { rows: ROWS, seed: 42 });

  // Load into a *fresh* database via the offline script path.
  const target = new Database(":memory:");
  target.exec(SCHEMA_DDL);
  target.exec(toSqlSqlite(data));
  assertValid(target);
  target.close();
  db.close();
});

test("subset + anonymize pulls a referentially-complete slice into a target DB", async () => {
  // Seed a source DB with real-looking data.
  const src = new Database(":memory:");
  src.exec(SCHEMA_DDL);
  src.exec(`
    INSERT INTO users (id, email, full_name, role, created_at) VALUES
      (1,'a@x.com','Alice','admin','2025-01-01T00:00:00Z'),
      (2,'b@x.com','Bob','member','2025-01-01T00:00:00Z'),
      (3,'c@x.com','Carol','guest','2025-01-01T00:00:00Z');
    INSERT INTO orders (id, user_id, status, total) VALUES
      (10,1,'paid',5.00),(11,2,'pending',9.00),(12,1,'shipped',3.00);
    INSERT INTO order_items (order_id, line_no, quantity) VALUES
      (10,1,2),(11,1,5),(12,1,1);
  `);
  const srcConn: Connection = {
    async query<T = any>(sql: string, params?: unknown[]) {
      const stmt = src.prepare(sql);
      const args = (params ?? []) as unknown[];
      return { rows: (stmt.reader ? stmt.all(...args) : (stmt.run(...args), [])) as T[] };
    },
    async end() {},
  };

  const schema = await introspectSqlite(srcConn, ["main"]);
  const { order } = topoSort(schema);
  const selected = await collectSubset(schema, { order_items: 2 }, new SqliteRowFetcher(srcConn));
  const data = anonymizeAll(schema, order, selected, { seed: 1 });

  // Insert the anonymized slice into a fresh target DB.
  const target = new Database(":memory:");
  target.exec(SCHEMA_DDL);
  const tgtConn: Connection = {
    async query<T = any>(sql: string, params?: unknown[]) {
      const stmt = target.prepare(sql);
      const args = (params ?? []) as unknown[];
      return { rows: (stmt.reader ? stmt.all(...args) : (stmt.run(...args), [])) as T[] };
    },
    async end() {},
  };
  const inserted = await insertDataSqlite(tgtConn, data, {});
  assert.ok(inserted > 0);

  // The two seeded order_items pulled their parent orders and grand-parent users;
  // every FK still resolves in the target.
  assert.equal(count(target, "SELECT count(*) n FROM order_items"), 2);
  assert.equal(
    count(target, "SELECT count(*) n FROM order_items i LEFT JOIN orders o ON o.id=i.order_id WHERE o.id IS NULL"),
    0,
  );
  assert.equal(
    count(target, "SELECT count(*) n FROM orders o LEFT JOIN users u ON u.id=o.user_id WHERE u.id IS NULL"),
    0,
  );
  // PII was scrubbed: emails differ from the originals but keys were preserved.
  const emails = (target.prepare("SELECT email FROM users").all() as any[]).map((r) => r.email);
  assert.ok(emails.every((e) => !["a@x.com", "b@x.com", "c@x.com"].includes(e)));

  src.close();
  target.close();
});
