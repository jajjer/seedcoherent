/**
 * End-to-end test against a real MySQL. Opt-in: skipped unless MYSQL_URL is set.
 * It provisions an isolated database, runs the full introspect → sort → generate
 * → insert pipeline, and verifies referential integrity, uniqueness, and the
 * MySQL-specific column shapes (AUTO_INCREMENT, ENUM, tinyint(1) booleans, JSON,
 * and 8.0.16+ CHECK constraints) directly in the database.
 *
 *   docker run -d --name my -e MYSQL_ROOT_PASSWORD=root -p 3306:3306 mysql:8
 *   MYSQL_URL=mysql://root:root@localhost:3306/ npm test
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import mysql from "mysql2/promise";
import { introspectMysql } from "../src/mysql-introspect.js";
import { insertDataMysql, MysqlSink, toSqlMysql } from "../src/mysql-emit.js";
import { topoSort } from "../src/graph.js";
import { buildData, generateInto } from "../src/generate.js";
import type { Connection } from "../src/types.js";

const url = process.env.MYSQL_URL;
const DB = "seedcoherent_test";
const enabled = !!url;

let raw: mysql.Connection;
let conn: Connection;

// The pipeline's INSERTs use *unqualified* table names, so the connection must
// have our database selected; introspection filters information_schema by name.
const DDL = `
  CREATE TABLE users (
    id         BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    email      VARCHAR(255) NOT NULL UNIQUE,
    full_name  VARCHAR(255) NOT NULL,
    role       ENUM('admin','member','guest') NOT NULL,
    -- A non-enum text column whose domain lives in a CHECK (col IN (...)), not
    -- the type: exercises MySQL IN-list CHECK parsing, distinct from the ENUM above.
    tier       VARCHAR(16) NOT NULL,
    is_active  TINYINT(1) NOT NULL,
    prefs      JSON,
    created_at DATETIME NOT NULL,
    CONSTRAINT chk_tier CHECK (tier IN ('free','pro','enterprise'))
  ) ENGINE=InnoDB;
  CREATE TABLE orders (
    id      BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    status  ENUM('pending','paid','shipped') NOT NULL,
    total   DECIMAL(10,2) NOT NULL,
    CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users(id),
    CONSTRAINT chk_total CHECK (total > 0)
  ) ENGINE=InnoDB;
  CREATE TABLE order_items (
    order_id BIGINT NOT NULL,
    line_no  INT NOT NULL,
    quantity INT NOT NULL,
    PRIMARY KEY (order_id, line_no),
    CONSTRAINT fk_items_order FOREIGN KEY (order_id) REFERENCES orders(id),
    CONSTRAINT chk_qty CHECK (quantity >= 1 AND quantity <= 100)
  ) ENGINE=InnoDB;
`;

before(async () => {
  if (!enabled) return;
  raw = await mysql.createConnection({ uri: url!, multipleStatements: true });
  await raw.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await raw.query(`CREATE DATABASE \`${DB}\``);
  await raw.query(`USE \`${DB}\``);
  await raw.query(DDL);
  conn = {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      const [rows] = await raw.query(sql, params);
      return { rows: rows as unknown as T[] };
    },
    async end() {},
  };
});

after(async () => {
  if (!enabled || !raw) return;
  await raw.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await raw.end();
});

const count = async (sql: string) => Number((await conn.query<{ n: number }>(sql)).rows[0].n);

/** Assert the DB holds referentially-correct, constraint-valid rows. */
async function assertValid(users: number, orders: number, items: number) {
  assert.equal(await count("SELECT count(*) n FROM users"), users);
  assert.equal(await count("SELECT count(*) n FROM orders"), orders);
  assert.equal(await count("SELECT count(*) n FROM order_items"), items);

  // Zero orphans across a simple and a composite FK.
  assert.equal(
    await count("SELECT count(*) n FROM orders o LEFT JOIN users u ON u.id=o.user_id WHERE u.id IS NULL"),
    0,
  );
  assert.equal(
    await count(
      "SELECT count(*) n FROM order_items i LEFT JOIN orders o ON o.id=i.order_id WHERE o.id IS NULL",
    ),
    0,
  );

  // UNIQUE email held (the insert would have failed otherwise, but assert it).
  assert.equal(await count("SELECT count(*)-count(DISTINCT email) n FROM users"), 0);

  // ENUM, tinyint(1) boolean, and CHECK bounds all landed within their domains.
  assert.equal(await count("SELECT count(*) n FROM users WHERE role NOT IN ('admin','member','guest')"), 0);
  // A non-enum text column constrained only by a CHECK (tier IN (...)).
  assert.equal(await count("SELECT count(*) n FROM users WHERE tier NOT IN ('free','pro','enterprise')"), 0);
  assert.equal(await count("SELECT count(*) n FROM users WHERE is_active NOT IN (0,1)"), 0);
  assert.equal(await count("SELECT count(*) n FROM orders WHERE status NOT IN ('pending','paid','shipped')"), 0);
  assert.equal(await count("SELECT count(*) n FROM orders WHERE NOT (total > 0)"), 0);
  assert.equal(await count("SELECT count(*) n FROM order_items WHERE quantity < 1 OR quantity > 100"), 0);

  // Every non-null JSON value is valid JSON (JSON_VALID is 1 for the column type,
  // but a malformed insert would have been rejected — assert it explicitly).
  assert.equal(await count("SELECT count(*) n FROM users WHERE prefs IS NOT NULL AND JSON_VALID(prefs)=0"), 0);
}

test("inserts referentially-correct data into a live MySQL database", { skip: !enabled }, async () => {
  const schema = await introspectMysql(conn, [DB]);
  assert.equal(schema.tables.size, 3);

  const { order, cyclic } = topoSort(schema);
  assert.equal(cyclic.size, 0);

  const data = buildData(schema, order, cyclic, {
    rows: {
      [`${DB}.users`]: 20,
      [`${DB}.orders`]: 60,
      [`${DB}.order_items`]: 150,
    },
    seed: 42,
  });

  const inserted = await insertDataMysql(conn, data);
  assert.equal(inserted, 230);
  await assertValid(20, 60, 150);
});

test("streams generation straight into batched INSERTs across many batches", { skip: !enabled }, async () => {
  const schema = await introspectMysql(conn, [DB]);
  const { order, cyclic } = topoSort(schema);

  // Small batch size forces multiple INSERT flushes per table; truncate the
  // prior test's rows first.
  const sink = new MysqlSink(conn, { truncate: true, tables: order }, 16);
  const stats = await generateInto(
    schema,
    order,
    cyclic,
    {
      rows: {
        [`${DB}.users`]: 100,
        [`${DB}.orders`]: 300,
        [`${DB}.order_items`]: 800,
      },
      seed: 99,
    },
    sink,
    16,
  );

  assert.equal(sink.inserted, 1200);
  assert.equal(new Map(stats.map((s) => [s.table.key, s.rows])).get(`${DB}.users`), 100);
  await assertValid(100, 300, 800);

  // Explicit AUTO_INCREMENT ids were inserted; MySQL advances its counter on its
  // own, so a subsequent DB-assigned insert must not collide with the seeded ids.
  const [res] = await raw.query(
    "INSERT INTO users (email, full_name, role, tier, is_active, created_at) VALUES ('post@example.com','Post','guest','free',1,'2025-01-01 00:00:00')",
  );
  assert.ok(Number((res as mysql.ResultSetHeader).insertId) > 100);
});

test("toSqlMysql emits a script that loads the same data", { skip: !enabled }, async () => {
  const schema = await introspectMysql(conn, [DB]);
  const { order, cyclic } = topoSort(schema);
  const data = buildData(schema, order, cyclic, {
    rows: {
      [`${DB}.users`]: 15,
      [`${DB}.orders`]: 40,
      [`${DB}.order_items`]: 90,
    },
    seed: 7,
  });

  // Load the offline script into a fresh copy of the schema.
  await raw.query("SET FOREIGN_KEY_CHECKS=0");
  await raw.query("DELETE FROM order_items");
  await raw.query("DELETE FROM orders");
  await raw.query("DELETE FROM users");
  await raw.query("SET FOREIGN_KEY_CHECKS=1");
  await raw.query(toSqlMysql(data));
  await assertValid(15, 40, 90);
});
