/**
 * End-to-end test against a real SQL Server. Opt-in: skipped unless MSSQL_URL is
 * set. It builds an isolated `sc_test` schema, runs the full introspect → sort →
 * generate → insert pipeline, and verifies referential integrity, uniqueness,
 * and the SQL Server-specific column shapes (IDENTITY, bit booleans,
 * uniqueidentifier, and CHECK constraints) directly in the database.
 *
 *   docker run -d --name mssql -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD=Str0ng!Passw0rd \
 *     -p 1433:1433 mcr.microsoft.com/mssql/server:2022-latest
 *   MSSQL_URL='sqlserver://sa:Str0ng!Passw0rd@localhost:1433/master?encrypt=false&trustServerCertificate=true' npm test
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import mssql from "mssql";
import { mssqlConfig } from "../src/dialect.js";
import { introspectMssql } from "../src/sqlserver-introspect.js";
import {
  insertDataMssql,
  MssqlSink,
  toSqlMssql,
} from "../src/sqlserver-emit.js";
import { topoSort } from "../src/graph.js";
import { buildData, generateInto } from "../src/generate.js";
import { anonymizeAll, collectSubset } from "../src/subset.js";
import { MssqlRowFetcher } from "../src/sqlserver-subset.js";
import type { Connection } from "../src/types.js";

const url = process.env.MSSQL_URL;
const enabled = !!url;
const SCHEMA = "sc_test";

let pool: mssql.ConnectionPool;
let conn: Connection;

const DROP = `
  IF OBJECT_ID('${SCHEMA}.order_items','U') IS NOT NULL DROP TABLE ${SCHEMA}.order_items;
  IF OBJECT_ID('${SCHEMA}.orders','U') IS NOT NULL DROP TABLE ${SCHEMA}.orders;
  IF OBJECT_ID('${SCHEMA}.users','U') IS NOT NULL DROP TABLE ${SCHEMA}.users;
`;

const DDL = `
  CREATE TABLE ${SCHEMA}.users (
    id         BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    email      NVARCHAR(255) NOT NULL UNIQUE,
    full_name  NVARCHAR(255) NOT NULL,
    tier       NVARCHAR(16) NOT NULL CONSTRAINT chk_tier CHECK (tier IN ('free','pro','enterprise')),
    is_active  BIT NOT NULL,
    ref        UNIQUEIDENTIFIER NULL,
    created_at DATETIME2 NOT NULL
  );
  CREATE TABLE ${SCHEMA}.orders (
    id      BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    user_id BIGINT NOT NULL CONSTRAINT fk_orders_user REFERENCES ${SCHEMA}.users(id),
    status  NVARCHAR(20) NOT NULL CONSTRAINT chk_status CHECK (status IN ('pending','paid','shipped')),
    total   DECIMAL(10,2) NOT NULL CONSTRAINT chk_total CHECK (total > 0)
  );
  CREATE TABLE ${SCHEMA}.order_items (
    order_id BIGINT NOT NULL CONSTRAINT fk_items_order REFERENCES ${SCHEMA}.orders(id),
    line_no  INT NOT NULL,
    quantity INT NOT NULL CONSTRAINT chk_qty CHECK (quantity >= 1 AND quantity <= 100),
    CONSTRAINT pk_items PRIMARY KEY (order_id, line_no)
  );
`;

// A second schema for the subset/anonymize tests. It mirrors the users → orders →
// order_items FK chain (including a composite PK) but uses plain BIGINT PKs instead
// of IDENTITY, so the tests can seed known ids with ordinary INSERTs and re-insert a
// subset slice back into the (truncated) same schema without IDENTITY_INSERT.
const SUB = "sc_sub";

const SUB_DROP = `
  IF OBJECT_ID('${SUB}.order_items','U') IS NOT NULL DROP TABLE ${SUB}.order_items;
  IF OBJECT_ID('${SUB}.orders','U') IS NOT NULL DROP TABLE ${SUB}.orders;
  IF OBJECT_ID('${SUB}.users','U') IS NOT NULL DROP TABLE ${SUB}.users;
`;

const SUB_DDL = `
  CREATE TABLE ${SUB}.users (
    id         BIGINT NOT NULL PRIMARY KEY,
    email      NVARCHAR(255) NOT NULL UNIQUE,
    full_name  NVARCHAR(255) NOT NULL
  );
  CREATE TABLE ${SUB}.orders (
    id      BIGINT NOT NULL PRIMARY KEY,
    user_id BIGINT NOT NULL CONSTRAINT fk_sub_orders_user REFERENCES ${SUB}.users(id),
    status  NVARCHAR(20) NOT NULL
  );
  CREATE TABLE ${SUB}.order_items (
    order_id BIGINT NOT NULL CONSTRAINT fk_sub_items_order REFERENCES ${SUB}.orders(id),
    line_no  INT NOT NULL,
    quantity INT NOT NULL,
    CONSTRAINT pk_sub_items PRIMARY KEY (order_id, line_no)
  );
`;

before(async () => {
  if (!enabled) return;
  pool = await new mssql.ConnectionPool(mssqlConfig(url!)).connect();
  conn = {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      const req = pool.request();
      (params ?? []).forEach((v, i) => req.input(`p${i + 1}`, v));
      const res = await req.query(sql);
      return { rows: (res.recordset ?? []) as unknown as T[] };
    },
    async end() {},
  };
  await pool.request().batch(DROP);
  await pool
    .request()
    .batch(`IF SCHEMA_ID('${SCHEMA}') IS NULL EXEC('CREATE SCHEMA ${SCHEMA}')`);
  await pool.request().batch(DDL);

  await pool.request().batch(SUB_DROP);
  await pool
    .request()
    .batch(`IF SCHEMA_ID('${SUB}') IS NULL EXEC('CREATE SCHEMA ${SUB}')`);
  await pool.request().batch(SUB_DDL);
});

after(async () => {
  if (!enabled || !pool) return;
  await pool.request().batch(SUB_DROP);
  await pool.request().batch(DROP);
  await pool.close();
});

const count = async (sql: string) =>
  Number((await conn.query<{ n: number }>(sql)).rows[0].n);

async function clear() {
  await conn.query(`DELETE FROM ${SCHEMA}.order_items`);
  await conn.query(`DELETE FROM ${SCHEMA}.orders`);
  await conn.query(`DELETE FROM ${SCHEMA}.users`);
}

/**
 * Seed the subset schema with a known, deterministic graph: 10 users, 6 orders
 * (users 1 and 2 own orders 100-102; users 3-5 own 103-105), and order_items
 * hanging off them. Child-first delete keeps the FKs happy on re-seed.
 */
async function seedSub() {
  await conn.query(`DELETE FROM ${SUB}.order_items`);
  await conn.query(`DELETE FROM ${SUB}.orders`);
  await conn.query(`DELETE FROM ${SUB}.users`);
  const users = Array.from(
    { length: 10 },
    (_, i) => `(${i + 1}, 'u${i + 1}@x.com', 'User ${i + 1}')`,
  ).join(",");
  await conn.query(
    `INSERT INTO ${SUB}.users (id, email, full_name) VALUES ${users}`,
  );
  await conn.query(
    `INSERT INTO ${SUB}.orders (id, user_id, status) VALUES
      (100,1,'paid'),(101,1,'pending'),(102,2,'paid'),
      (103,3,'shipped'),(104,4,'paid'),(105,5,'pending')`,
  );
  await conn.query(
    `INSERT INTO ${SUB}.order_items (order_id, line_no, quantity) VALUES
      (100,1,2),(100,2,1),(101,1,5),(102,1,3),(103,1,4),(104,1,1),(105,1,2)`,
  );
}

/** Assert the DB holds referentially-correct, constraint-valid rows. */
async function assertValid(users: number, orders: number, items: number) {
  assert.equal(await count(`SELECT count(*) n FROM ${SCHEMA}.users`), users);
  assert.equal(await count(`SELECT count(*) n FROM ${SCHEMA}.orders`), orders);
  assert.equal(
    await count(`SELECT count(*) n FROM ${SCHEMA}.order_items`),
    items,
  );

  // Zero orphans across a simple and a composite FK.
  assert.equal(
    await count(
      `SELECT count(*) n FROM ${SCHEMA}.orders o LEFT JOIN ${SCHEMA}.users u ON u.id=o.user_id WHERE u.id IS NULL`,
    ),
    0,
  );
  assert.equal(
    await count(
      `SELECT count(*) n FROM ${SCHEMA}.order_items i LEFT JOIN ${SCHEMA}.orders o ON o.id=i.order_id WHERE o.id IS NULL`,
    ),
    0,
  );

  // UNIQUE email held.
  assert.equal(
    await count(`SELECT count(*)-count(DISTINCT email) n FROM ${SCHEMA}.users`),
    0,
  );

  // CHECK / domain bounds all landed within range.
  assert.equal(
    await count(
      `SELECT count(*) n FROM ${SCHEMA}.users WHERE tier NOT IN ('free','pro','enterprise')`,
    ),
    0,
  );
  assert.equal(
    await count(
      `SELECT count(*) n FROM ${SCHEMA}.orders WHERE status NOT IN ('pending','paid','shipped')`,
    ),
    0,
  );
  assert.equal(
    await count(
      `SELECT count(*) n FROM ${SCHEMA}.orders WHERE NOT (total > 0)`,
    ),
    0,
  );
  assert.equal(
    await count(
      `SELECT count(*) n FROM ${SCHEMA}.order_items WHERE quantity < 1 OR quantity > 100`,
    ),
    0,
  );
}

test(
  "inserts referentially-correct data into a live SQL Server database",
  { skip: !enabled },
  async () => {
    await clear();
    const schema = await introspectMssql(conn, [SCHEMA]);
    assert.equal(schema.tables.size, 3);

    const { order, cyclic } = topoSort(schema);
    assert.equal(cyclic.size, 0);

    const data = buildData(schema, order, cyclic, {
      rows: {
        [`${SCHEMA}.users`]: 20,
        [`${SCHEMA}.orders`]: 60,
        [`${SCHEMA}.order_items`]: 150,
      },
      seed: 42,
    });

    const inserted = await insertDataMssql(conn, data);
    assert.equal(inserted, 230);
    await assertValid(20, 60, 150);
  },
);

test(
  "streams generation straight into batched INSERTs across many batches",
  { skip: !enabled },
  async () => {
    const schema = await introspectMssql(conn, [SCHEMA]);
    const { order, cyclic } = topoSort(schema);

    // Small batch size forces multiple INSERT flushes per table; truncate first.
    const sink = new MssqlSink(conn, { truncate: true, tables: order }, 16);
    const stats = await generateInto(
      schema,
      order,
      cyclic,
      {
        rows: {
          [`${SCHEMA}.users`]: 100,
          [`${SCHEMA}.orders`]: 300,
          [`${SCHEMA}.order_items`]: 800,
        },
        seed: 99,
      },
      sink,
      16,
    );

    assert.equal(sink.inserted, 1200);
    assert.equal(
      new Map(stats.map((s) => [s.table.key, s.rows])).get(`${SCHEMA}.users`),
      100,
    );
    await assertValid(100, 300, 800);

    // Explicit IDENTITY ids were inserted and the seed was reset in finalize, so a
    // subsequent DB-assigned insert must not collide with the seeded ids.
    const res = await conn.query<{ id: number }>(
      `INSERT INTO ${SCHEMA}.users (email, full_name, tier, is_active, created_at)
       OUTPUT INSERTED.id AS id
       VALUES ('post@example.com','Post','free',1,'2025-01-01T00:00:00')`,
    );
    assert.ok(Number(res.rows[0].id) > 100);
  },
);

test(
  "toSqlMssql emits a script that loads the same data",
  { skip: !enabled },
  async () => {
    const schema = await introspectMssql(conn, [SCHEMA]);
    const { order, cyclic } = topoSort(schema);
    const data = buildData(schema, order, cyclic, {
      rows: {
        [`${SCHEMA}.users`]: 15,
        [`${SCHEMA}.orders`]: 40,
        [`${SCHEMA}.order_items`]: 90,
      },
      seed: 7,
    });

    await clear();
    await pool.request().batch(toSqlMssql(data));
    await assertValid(15, 40, 90);
  },
);

test(
  "subset + anonymize pulls a referentially-complete slice and re-inserts it",
  { skip: !enabled },
  async () => {
    await seedSub();
    const schema = await introspectMssql(conn, [SUB]);
    const { order } = topoSort(schema);
    const origEmails = (
      await conn.query<{ email: string }>(`SELECT email FROM ${SUB}.users`)
    ).rows.map((r) => r.email);

    // TOP (2) ORDER BY the composite PK pulls order_items (100,1) and (100,2),
    // which drag in order 100 and its owner, user 1.
    const selected = await collectSubset(
      schema,
      { [`${SUB}.order_items`]: 2 },
      new MssqlRowFetcher(conn),
    );
    const data = anonymizeAll(schema, order, selected, { seed: 1 });

    // Re-insert the anonymized slice into the (truncated) same schema.
    const inserted = await insertDataMssql(conn, data, { truncate: true });
    assert.ok(inserted > 0);

    // The slice stands alone: every FK still resolves across the simple and the
    // composite FK, and only the two seeded items survive.
    assert.equal(await count(`SELECT count(*) n FROM ${SUB}.order_items`), 2);
    assert.equal(
      await count(
        `SELECT count(*) n FROM ${SUB}.order_items i LEFT JOIN ${SUB}.orders o ON o.id=i.order_id WHERE o.id IS NULL`,
      ),
      0,
    );
    assert.equal(
      await count(
        `SELECT count(*) n FROM ${SUB}.orders o LEFT JOIN ${SUB}.users u ON u.id=o.user_id WHERE u.id IS NULL`,
      ),
      0,
    );

    // Email PII was scrubbed: no surviving address matches an original.
    const newEmails = (
      await conn.query<{ email: string }>(`SELECT email FROM ${SUB}.users`)
    ).rows.map((r) => r.email);
    assert.ok(newEmails.length > 0);
    assert.ok(newEmails.every((e) => !origEmails.includes(e)));
  },
);

test(
  "--children traverses FKs downward from root users",
  { skip: !enabled },
  async () => {
    await seedSub();
    const schema = await introspectMssql(conn, [SUB]);
    // Roots: TOP (2) ORDER BY id → users 1 and 2. children=true walks downward.
    const selected = await collectSubset(
      schema,
      { [`${SUB}.users`]: 2 },
      new MssqlRowFetcher(conn),
      {},
      false,
      true,
    );

    const userIds = (selected.get(`${SUB}.users`) ?? [])
      .map((r) => Number(r.id))
      .sort((a, b) => a - b);
    const orderIds = (selected.get(`${SUB}.orders`) ?? [])
      .map((r) => Number(r.id))
      .sort((a, b) => a - b);
    const itemKeys = (selected.get(`${SUB}.order_items`) ?? [])
      .map((r) => `${r.order_id}:${r.line_no}`)
      .sort();

    assert.deepEqual(userIds, [1, 2]);
    // Only orders owned by users 1 and 2 — never 103-105, owned by users 3-5.
    assert.deepEqual(orderIds, [100, 101, 102]);
    // Their order_items came along; none from the excluded orders.
    assert.deepEqual(itemKeys, ["100:1", "100:2", "101:1", "102:1"]);
  },
);

test(
  "--sample-rate + --seed draws a reproducible user slice; a new seed differs",
  { skip: !enabled },
  async () => {
    await seedSub();
    const schema = await introspectMssql(conn, [SUB]);
    // users has no FKs, so the slice is just the sampled users bucket.
    const ids = async (seed: number) => {
      const sel = await collectSubset(
        schema,
        { [`${SUB}.users`]: 0 },
        new MssqlRowFetcher(conn),
        {},
        false,
        false,
        { [`${SUB}.users`]: 0.5 }, // ceil(0.5 * 10) = 5 rows
        seed,
      );
      return (sel.get(`${SUB}.users`) ?? [])
        .map((r) => Number(r.id))
        .sort((a, b) => a - b);
    };

    const a = await ids(123);
    const b = await ids(123);
    const c = await ids(456);
    assert.equal(a.length, 5);
    assert.deepEqual(a, b, "same seed → identical sample");
    assert.notDeepEqual(a, c, "different seed → different sample");
  },
);
