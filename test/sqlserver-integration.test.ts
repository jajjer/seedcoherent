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
});

after(async () => {
  if (!enabled || !pool) return;
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
