# seedcoherent

**Point it at your Postgres schema, get coherent, referentially-correct fake data.**

Faker doesn't understand your schema. `seedcoherent` reads your live database,
walks the foreign-key graph, and generates data that actually fits: FKs point at
real parent rows, unique constraints hold, enums use their real values, and
column *names* drive realistic content — `email` gets emails, `price` gets money,
`created_at` gets plausible timestamps.

```bash
npx seedcoherent postgres://localhost/mydb --rows users=1000 orders=5000
```

That's it. No config, no schema annotations, no per-column mapping. It introspects
everything and inserts in dependency order inside a single transaction.

## Why it's different

- **Referentially correct.** Children reference parents that exist. Zero orphan
  rows, including composite and self-referential foreign keys.
- **Constraint-aware.** Respects `NOT NULL`, `UNIQUE` (single + composite),
  enums, `varchar(n)` length, identity/serial PKs, and common `CHECK`
  constraints — numeric ranges (`price > 0`), `IN (...)` sets, and
  `char_length` bounds all shape the generated values.
- **Looks real.** Name + type inference means `first_name`, `phone`, `city`,
  `status`, `total` come out looking like your actual data — not lorem ipsum.
- **Deterministic.** `--seed 42` gives byte-identical output every run.
- **Zero install.** One `npx` command against any Postgres database.

## Usage

```bash
# Insert directly (default). Use --truncate to clear tables first.
npx seedcoherent $DATABASE_URL --rows users=1000 orders=5000 --truncate

# Write a .sql file instead of inserting
npx seedcoherent $DATABASE_URL --rows users=1000 -o seed.sql

# Print SQL to stdout
npx seedcoherent $DATABASE_URL --rows users=100 --print

# Deterministic output
npx seedcoherent $DATABASE_URL --rows users=100 --seed 42
```

Connection string comes from the first argument or `DATABASE_URL`.

### Options

| Flag | Description |
| --- | --- |
| `-r, --rows <table=n...>` | Rows per table, e.g. `users=1000 orders=5000` |
| `-d, --default-rows <n>` | Rows for tables not listed (default: 10) |
| `-s, --seed <n>` | RNG seed for reproducible output |
| `--batch-size <n>` | Rows per `COPY` batch (default: 10000; does not change output) |
| `--schema <name...>` | Schema(s) to read (default: `public`) |
| `--skip <table...>` | Tables to leave empty |
| `-c, --config <path>` | Config file (see below) |
| `-o, --out <file>` | Write SQL to a file instead of inserting |
| `--print` | Print SQL to stdout |
| `--truncate` | `TRUNCATE ... RESTART IDENTITY CASCADE` before inserting |
| `--subset <table=n...>` | Subset + anonymize real data (see below) |
| `--to <connection>` | Target DB to insert the anonymized subset into |
| `--anonymize <col...>` | Also scrub these join keys (see below) |
| `--preserve <col...>` | Keep these columns' real values (see below) |

## Subset + anonymize real data

Point `seedcoherent` at a **real** database, pull a small, referentially-complete
slice of it, and scrub the PII on the way out — perfect for filling a staging or
CI database with realistic-but-fake data.

```bash
# 500 orders and *everything they reference* (users, products, categories…),
# anonymized, inserted into a separate staging DB.
npx seedcoherent $PROD_URL --subset orders=500 --to $STAGING_URL --seed 42

# Or write it to a file / stdout instead of a live target.
npx seedcoherent $PROD_URL --subset orders=500 -o staging-seed.sql
```

How it works:

1. **Seed** — take up to `n` rows from each root table in `--subset`.
2. **Close** — walk foreign keys *upward* to a fixpoint so every referenced
   parent row is pulled in too. The resulting slice has zero dangling FKs,
   including composite and self-referential keys.
3. **Anonymize** — every non-key column is replaced using the same name/type
   inference that powers generation (`email` → fake email, `first_name` → fake
   name, …). The same original value always maps to the same fake within a
   column, so internal duplicates stay consistent and `UNIQUE` columns stay
   unique. `NULL`s are preserved.

To keep the join graph intact, **key columns are passed through verbatim** by
default — primary keys, foreign-key columns, and any column referenced by a
foreign key. Anonymized data is never written back to the source — a subset run
requires `--to`, `--out`, or `--print`.

### Per-column control

The defaults are conservative — non-keys scrubbed, keys kept — but you can
override either side per column:

```bash
# A natural key that is itself PII (e.g. an email used as a primary key) is
# preserved by default. --anonymize opts it into scrubbing, and every foreign
# key that references it is remapped to match, so joins still resolve.
npx seedcoherent $PROD_URL --subset sessions=500 --to $STAGING_URL \
  --anonymize accounts.email

# Keep a non-key column's real values (e.g. so staging keeps a realistic
# country/plan distribution).
npx seedcoherent $PROD_URL --subset orders=500 --to $STAGING_URL \
  --preserve users.country users.plan
```

`--anonymize` works on a whole **join group**: because both sides of a foreign
key hold the same value, naming *either* the referenced key or a referencing FK
column scrubs the entire group consistently. The same original always maps to
the same fake across every table, so referential integrity is preserved.
Columns are matched as `table.column`, `schema.table.column`, or a bare
`column`. Both flags also read from `anonymize` / `preserve` arrays in the
[config file](#config-file).

## Config file

Drop a `seed.config.json` next to where you run the command to override
generators or set counts. CLI flags win over the file.

```json
{
  "defaultRows": 50,
  "seed": 42,
  "rows": { "users": 1000, "orders": 5000 },
  "skip": ["audit_log"],
  "columns": {
    "users.email": "internet.email",
    "orders.status": { "values": ["paid", "shipped"] },
    "products.price": { "faker": "commerce.price" }
  },
  "anonymize": ["accounts.email"],
  "preserve": ["users.country"]
}
```

Column overrides accept a faker path (`"internet.email"`), `{ "faker": "..." }`,
a fixed `{ "value": ... }`, or `{ "values": [...] }` to pick from a list. Keys are
`table.column` or a bare `column` to apply everywhere.

`anonymize` and `preserve` are subset-mode lists of columns to scrub or keep,
matching the `--anonymize` / `--preserve` flags (which append to them).

## Try it locally

```bash
docker run -d --name pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
psql postgres://postgres:postgres@localhost:5432/postgres -f examples/schema.sql
npm run dev -- postgres://postgres:postgres@localhost:5432/postgres \
  --rows categories=8 users=50 products=40 orders=120 order_items=300 --seed 42
```

## How it works

1. **Introspect** — reads tables, columns, PKs, unique/foreign-key/check
   constraints, and enum types from `pg_catalog`.
2. **Order** — topologically sorts tables so parents populate before children;
   cycles and self-references are broken and handled with a deferred pass.
3. **Infer** — picks a value generator per column from its name and type.
4. **Generate** — builds rows, drawing FK values from already-generated parents
   and de-duplicating uniques.
5. **Emit** — streams rows in dependency order into Postgres with `COPY ... FROM
   STDIN`, batched (`--batch-size`) so generation never holds the whole dataset
   in memory, all inside one transaction. `--out`/`--print` write an `INSERT`
   script instead.

## Tests

```bash
npm test          # unit tests — no database required
```

The suite covers the pure logic end-to-end: FK topological ordering, name/type
inference and overrides, SQL-literal formatting, config parsing, and seeded
determinism. A live-database integration test (real introspect → generate →
insert, then asserts zero orphan rows) runs only when `DATABASE_URL` is set:

```bash
docker run -d --name pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm test
```

## Status

v0 — Postgres, with two modes: generate-from-scratch and subset + anonymize real
production data into staging. On the roadmap: MySQL/SQLite and hosted generation.

## License

MIT
