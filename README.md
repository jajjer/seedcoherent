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
  enums, `varchar(n)` length, and identity/serial PKs.
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
| `--schema <name...>` | Schema(s) to read (default: `public`) |
| `--skip <table...>` | Tables to leave empty |
| `-c, --config <path>` | Config file (see below) |
| `-o, --out <file>` | Write SQL to a file instead of inserting |
| `--print` | Print SQL to stdout |
| `--truncate` | `TRUNCATE ... RESTART IDENTITY CASCADE` before inserting |

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
  }
}
```

Column overrides accept a faker path (`"internet.email"`), `{ "faker": "..." }`,
a fixed `{ "value": ... }`, or `{ "values": [...] }` to pick from a list. Keys are
`table.column` or a bare `column` to apply everywhere.

## Try it locally

```bash
docker run -d --name pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
psql postgres://postgres:postgres@localhost:5432/postgres -f examples/schema.sql
npm run dev -- postgres://postgres:postgres@localhost:5432/postgres \
  --rows categories=8 users=50 products=40 orders=120 order_items=300 --seed 42
```

## How it works

1. **Introspect** — reads tables, columns, PKs, unique/foreign-key constraints,
   and enum types from `pg_catalog`.
2. **Order** — topologically sorts tables so parents populate before children;
   cycles and self-references are broken and handled with a deferred pass.
3. **Infer** — picks a value generator per column from its name and type.
4. **Generate** — builds rows, drawing FK values from already-generated parents
   and de-duplicating uniques.
5. **Emit** — inserts in dependency order in one transaction, or writes SQL.

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

v0 — Postgres, generate-from-scratch. On the roadmap: subset + anonymize real
production data into staging, MySQL/SQLite, and hosted generation.

## License

MIT
