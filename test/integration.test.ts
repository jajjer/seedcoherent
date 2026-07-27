/**
 * End-to-end test against a real Postgres. Opt-in: skipped unless DATABASE_URL
 * is set. It provisions an isolated schema, runs the full introspect → sort →
 * generate → insert pipeline, and verifies referential integrity in the DB.
 *
 *   docker run -d --name pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm test
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { introspect } from "../src/introspect.js";
import { topoSort } from "../src/graph.js";
import { buildData } from "../src/generate.js";
import { insertInto } from "../src/emit.js";

const url = process.env.DATABASE_URL;
const SCHEMA = "seedcoherent_test";
const enabled = !!url;

let client: pg.Client;

before(async () => {
  if (!enabled) return;
  client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  await client.query(`
    CREATE TYPE ${SCHEMA}.order_status AS ENUM ('pending', 'paid', 'shipped');
    CREATE TABLE ${SCHEMA}.users (
      id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      email      text NOT NULL UNIQUE,
      full_name  text NOT NULL,
      created_at timestamptz NOT NULL
    );
    CREATE TABLE ${SCHEMA}.orders (
      id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id  bigint NOT NULL REFERENCES ${SCHEMA}.users(id),
      status   ${SCHEMA}.order_status NOT NULL,
      total    numeric(10,2) NOT NULL CHECK (total > 0)
    );
    CREATE TABLE ${SCHEMA}.order_items (
      order_id   bigint NOT NULL REFERENCES ${SCHEMA}.orders(id),
      line_no    int NOT NULL,
      quantity   int NOT NULL,
      PRIMARY KEY (order_id, line_no),
      CHECK (quantity >= 1 AND quantity <= 100)
    );
  `);
});

after(async () => {
  if (!enabled || !client) return;
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.end();
});

test("inserts referentially-correct data into a live database", { skip: !enabled }, async () => {
  const schema = await introspect(client, [SCHEMA]);
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

  const inserted = await insertInto(client, data);
  assert.ok(inserted > 0);

  // Row counts landed.
  const count = async (t: string) =>
    Number((await client.query(`SELECT count(*)::int AS n FROM ${SCHEMA}.${t}`)).rows[0].n);
  assert.equal(await count("users"), 20);
  assert.equal(await count("orders"), 60);

  // Zero orphan orders.
  const orphanOrders = await client.query(`
    SELECT count(*)::int AS n FROM ${SCHEMA}.orders o
    LEFT JOIN ${SCHEMA}.users u ON u.id = o.user_id
    WHERE u.id IS NULL
  `);
  assert.equal(orphanOrders.rows[0].n, 0);

  // Zero orphan order_items (composite parent).
  const orphanItems = await client.query(`
    SELECT count(*)::int AS n FROM ${SCHEMA}.order_items i
    LEFT JOIN ${SCHEMA}.orders o ON o.id = i.order_id
    WHERE o.id IS NULL
  `);
  assert.equal(orphanItems.rows[0].n, 0);

  // Enum values are valid (guaranteed by the column type, but assert the insert succeeded with them).
  const statuses = await client.query(
    `SELECT DISTINCT status::text AS s FROM ${SCHEMA}.orders ORDER BY s`,
  );
  for (const { s } of statuses.rows) {
    assert.ok(["pending", "paid", "shipped"].includes(s));
  }

  // CHECK constraints held: total > 0 and quantity in [1, 100].
  // (The insert transaction would have aborted otherwise, but assert directly.)
  const badTotals = await client.query(
    `SELECT count(*)::int AS n FROM ${SCHEMA}.orders WHERE NOT (total > 0)`,
  );
  assert.equal(badTotals.rows[0].n, 0);
  const badQty = await client.query(
    `SELECT count(*)::int AS n FROM ${SCHEMA}.order_items WHERE NOT (quantity BETWEEN 1 AND 100)`,
  );
  assert.equal(badQty.rows[0].n, 0);
});

test("--truncate clears and re-seeds without constraint errors", { skip: !enabled }, async () => {
  const schema = await introspect(client, [SCHEMA]);
  const { order, cyclic } = topoSort(schema);
  const data = buildData(schema, order, cyclic, {
    rows: {
      [`${SCHEMA}.users`]: 5,
      [`${SCHEMA}.orders`]: 10,
      [`${SCHEMA}.order_items`]: 15,
    },
    seed: 7,
  });

  await insertInto(client, data, true); // truncate first
  const n = Number(
    (await client.query(`SELECT count(*)::int AS n FROM ${SCHEMA}.users`)).rows[0].n,
  );
  assert.equal(n, 5);
});
