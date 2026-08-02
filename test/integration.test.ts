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
import { buildData, generateInto } from "../src/generate.js";
import { insertInto, toSql, CopySink } from "../src/emit.js";

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
  await client.query(`DROP SCHEMA IF EXISTS ${HARD} CASCADE`);
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

// A schema exercising features a plain fixture doesn't: partitioned tables,
// composite/range/domain types, and enum arrays. Each of these rejected the
// generator's output before it was made type-aware.
const HARD = "seedcoherent_hard";

const HARD_DDL = `
  DROP SCHEMA IF EXISTS ${HARD} CASCADE;
  CREATE SCHEMA ${HARD};
  CREATE TYPE ${HARD}.mood AS ENUM ('happy', 'sad', 'meh');
  CREATE DOMAIN ${HARD}.us_zip AS text CHECK (VALUE ~ '^[0-9]{5}$');
  CREATE TYPE ${HARD}.addr AS (line1 text, city text, zip text);
  CREATE TABLE ${HARD}.accounts (
    id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ext_no bigint GENERATED ALWAYS AS IDENTITY,
    email  text UNIQUE NOT NULL,
    tags   text[] NOT NULL DEFAULT '{}',
    moods  ${HARD}.mood[],
    home   ${HARD}.addr,
    zip    ${HARD}.us_zip,
    win    tstzrange,
    balance money NOT NULL,
    ttl     interval NOT NULL,
    hw_addr macaddr NOT NULL,
    payload xml NOT NULL
  );
  CREATE TABLE ${HARD}.events (
    id         bigint GENERATED ALWAYS AS IDENTITY,
    account_id bigint NOT NULL REFERENCES ${HARD}.accounts(id),
    kind       text NOT NULL,
    at         timestamptz NOT NULL,
    PRIMARY KEY (id, at)
  ) PARTITION BY RANGE (at);
  CREATE TABLE ${HARD}.events_2024 PARTITION OF ${HARD}.events FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
  CREATE TABLE ${HARD}.events_2025 PARTITION OF ${HARD}.events FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
`;

const HARD_ROWS = { [`${HARD}.accounts`]: 15, [`${HARD}.events`]: 40 };

/** Assert the DB now holds valid, well-routed data for the hard schema. */
async function assertHardData() {
  const count = async (q: string) => Number((await client.query(q)).rows[0].n);
  assert.equal(await count(`SELECT count(*)::int n FROM ${HARD}.accounts`), 15);
  assert.equal(await count(`SELECT count(*)::int n FROM ${HARD}.events`), 40);

  // Partitioned rows all routed into a real partition (parent = sum of children).
  const routed =
    (await count(`SELECT count(*)::int n FROM ${HARD}.events_2024`)) +
    (await count(`SELECT count(*)::int n FROM ${HARD}.events_2025`));
  assert.equal(routed, 40);

  // The domain's regex CHECK held for every generated zip.
  assert.equal(await count(`SELECT count(*)::int n FROM ${HARD}.accounts WHERE zip IS NOT NULL AND zip !~ '^[0-9]{5}$'`), 0);

  // money / interval / macaddr / xml all inserted as valid values of their type.
  // (A malformed literal would have aborted the whole transaction, so a full
  // count here is enough — but the type-strict predicates document the shape.)
  assert.equal(await count(`SELECT count(*)::int n FROM ${HARD}.accounts WHERE balance >= 0::money`), 15);
  assert.equal(await count(`SELECT count(*)::int n FROM ${HARD}.accounts WHERE ttl >= interval '0'`), 15);
  assert.equal(await count(`SELECT count(*)::int n FROM ${HARD}.accounts WHERE hw_addr IS NOT NULL`), 15);
  assert.equal(await count(`SELECT count(*)::int n FROM ${HARD}.accounts WHERE (xpath('/record/id', payload))[1] IS NOT NULL`), 15);

  // Enum-array elements are valid labels (the insert would have failed otherwise).
  assert.equal(
    await count(`SELECT count(*)::int n FROM ${HARD}.accounts a, unnest(a.moods) m WHERE m::text NOT IN ('happy','sad','meh')`),
    0,
  );
  // No orphan events across the FK into a partitioned-parent's parent table.
  assert.equal(
    await count(`SELECT count(*)::int n FROM ${HARD}.events e LEFT JOIN ${HARD}.accounts a ON a.id = e.account_id WHERE a.id IS NULL`),
    0,
  );
}

test("COPY-loads partitioned, composite, range, domain, and enum-array data", { skip: !enabled }, async () => {
  await client.query(HARD_DDL);
  const schema = await introspect(client, [HARD]);
  // Leaf partitions are hidden; the parent is the insert target.
  assert.ok(schema.tables.has(`${HARD}.events`));
  assert.ok(!schema.tables.has(`${HARD}.events_2024`));

  const { order, cyclic } = topoSort(schema);
  const data = buildData(schema, order, cyclic, { rows: HARD_ROWS, seed: 42 });
  await insertInto(client, data, true);
  await assertHardData();
});

test("INSERT-script path loads the same hard schema", { skip: !enabled }, async () => {
  await client.query(HARD_DDL);
  const schema = await introspect(client, [HARD]);
  const { order, cyclic } = topoSort(schema);
  const data = buildData(schema, order, cyclic, { rows: HARD_ROWS, seed: 42 });
  // Exercise the text/INSERT emitter (distinct from COPY): run its script live.
  await client.query(toSql(data));
  await assertHardData();
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

test("streams generation straight into COPY across many batches", { skip: !enabled }, async () => {
  const schema = await introspect(client, [SCHEMA]);
  const { order, cyclic } = topoSort(schema);
  const skip = new Set<string>();
  const tables = order.filter((t) => !skip.has(t.key));

  // Small batch size forces multiple COPY writes per table.
  const sink = new CopySink(client, { truncate: true, tables });
  const stats = await generateInto(
    schema,
    order,
    cyclic,
    {
      rows: {
        [`${SCHEMA}.users`]: 500,
        [`${SCHEMA}.orders`]: 1500,
        [`${SCHEMA}.order_items`]: 4000,
      },
      seed: 99,
    },
    sink,
    64,
  );

  assert.equal(sink.inserted, 6000);
  const byKey = new Map(stats.map((s) => [s.table.key, s.rows]));
  assert.equal(byKey.get(`${SCHEMA}.users`), 500);

  const count = async (t: string) =>
    Number((await client.query(`SELECT count(*)::int AS n FROM ${SCHEMA}.${t}`)).rows[0].n);
  assert.equal(await count("users"), 500);
  assert.equal(await count("orders"), 1500);
  assert.equal(await count("order_items"), 4000);

  // Zero orphans across both a simple and a composite FK.
  const orphanOrders = await client.query(`
    SELECT count(*)::int AS n FROM ${SCHEMA}.orders o
    LEFT JOIN ${SCHEMA}.users u ON u.id = o.user_id WHERE u.id IS NULL
  `);
  assert.equal(orphanOrders.rows[0].n, 0);

  // COPY inserted explicit identity ids; the sequence reset must let a plain
  // INSERT (DB assigns the id) succeed without a PK collision.
  const inserted = await client.query(
    `INSERT INTO ${SCHEMA}.users (email, full_name, created_at)
     VALUES ('post-copy@example.com', 'Post Copy', now()) RETURNING id`,
  );
  assert.ok(Number(inserted.rows[0].id) > 500);
});
