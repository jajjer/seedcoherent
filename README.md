# seedcoherent

**Point it at your Postgres, MySQL, or SQLite schema, get coherent, referentially-correct fake data.**

![seedcoherent demo](demo/demo.gif)

Faker doesn't understand your schema. `seedcoherent` reads your live database,
walks the foreign-key graph, and generates data that actually fits: FKs point at
real parent rows, unique constraints hold, enums use their real values, and
column *names* drive realistic content — `email` gets emails, `price` gets money,
`created_at` gets plausible timestamps.

```bash
npx seedcoherent postgres://localhost/mydb --rows users=1000 orders=5000
npx seedcoherent mysql://root@localhost/mydb --rows users=1000 orders=5000
npx seedcoherent ./mydb.sqlite --rows users=1000 orders=5000
```

The database is picked from the connection string: a `postgres://` /
`postgresql://` or `mysql://` scheme selects that engine, while a `sqlite:` /
`file:` URL, a `:memory:` marker, or a bare path to a `.db` / `.sqlite` /
`.sqlite3` file selects SQLite — so the same commands work against any of them.

That's it. No config, no schema annotations, no per-column mapping. It introspects
everything and inserts in dependency order inside a single transaction.

## Why it's different

- **Referentially correct.** Children reference parents that exist. Zero orphan
  rows, including composite and self-referential foreign keys.
- **Constraint-aware.** Respects `NOT NULL`, `UNIQUE` (single + composite),
  enums, `varchar(n)` length, identity/serial PKs, and common `CHECK`
  constraints — numeric ranges (`price > 0`), `IN (...)` sets, `char_length`
  bounds, and simple `~` regex patterns all shape the generated values.
- **Handles real schemas.** Partitioned tables (rows are generated for the
  parent and land in a covered partition), composite types, range types,
  domains (with their `CHECK`s), and arrays — including `enum[]` — all generate
  valid values instead of crashing the insert. The everyday non-scalar types —
  `money`, `interval`, `macaddr`/`macaddr8`, `inet`/`cidr`, `uuid`, `xml`, and
  `bytea` — generate valid literals too.
- **Looks real.** Name + type inference means `first_name`, `phone`, `city`,
  `status`, `total` come out looking like your actual data — not lorem ipsum.
  The same name inference shapes `json`/`jsonb` columns: an `address` column
  gets `{street, city, state, zip, country}`, `tags` a JSON string array,
  `settings` a `{theme, language, notifications}` object — not one opaque stub.
- **Speaks your language.** US English by default, but `--locale de` (or `fr`,
  `ja`, `pt_BR`, `en_GB`, … — any of Faker's 70-plus locales) generates names,
  emails, companies, phone numbers, and addresses in that locale, so a German
  schema gets German names and phone formats instead of American ones. Name
  coherence (a row's `full_name`/`email` from its own first + last name) follows
  the locale; the US-specific zip-inside-state coherence stays a US-locale
  feature.
- **Realistic relationships.** Foreign keys don't have to fan out evenly. Ask for
  a `zipf` distribution and a few parents collect most of the children while the
  rest thin into a long tail — the lopsided shape real data has — so "top
  customers", pagination, and GROUP BY cardinalities behave like production.
- **Lopsided categories, too.** The same `--distribution` knob shapes a
  categorical column's own values — an enum, a `CHECK ... IN (...)` set, or a
  `values:` list. Ask for `status=weighted:paid=0.9,refunded=0.1` and 90% of
  orders come out `paid`; ask for `zipf` and the column skews toward its first
  label — no more dead-even splits across states real data never has.
- **Grows existing data, not just fresh schemas.** `--append` adds rows to a
  database that already has data: only the tables you name grow, their foreign
  keys reference the rows already there, and synthetic ids continue past the
  current max so nothing collides. "Add 5,000 orders to my existing users" is one
  flag.
- **Temporally coherent.** Timestamps respect causality. A row's `updated_at`,
  `last_login`, or `expires_at` never predates its `created_at`, and a child's
  `created_at` never predates the parent it points at — so an order can't be
  placed before its customer signed up. `--since` / `--until` bound the window,
  so "all data from the last quarter" is two flags.
- **Coherent within a row.** Fields that describe the same thing agree. A row's
  `full_name`, `email`, and `username` all come from its own `first_name` +
  `last_name` (and a `gender`/`sex` column steers the name), and a `zip` and
  `city` both land inside its row's `state` with `country` set to match — no
  California ZIPs (or San Franciscos) on Texas rows. `billing_*` and `shipping_*`
  blocks are kept independent.
- **Deterministic.** `--seed 42` gives byte-identical output every run.
- **Preview before you write.** `--dry-run` prints the table order, row counts,
  and a few sample rows without touching the database. It works for subset +
  anonymize runs too: the source is read, but the preview shows the real
  closed-over counts and the actual scrubbed values — nothing is written to the
  target.
- **Fast.** ~300k rows/sec end-to-end (generate + insert) on SQLite — a 1.1M-row,
  5-table graph seeds in under 4 seconds on a laptop. Run `npm run benchmark` to
  measure it on your machine.
- **Three databases, one tool.** Postgres, MySQL, and SQLite, selected from the
  connection string — same flags, same behavior. On MySQL, `AUTO_INCREMENT` PKs,
  `ENUM`, `tinyint(1)` booleans, `JSON`, and `CHECK` constraints (8.0.16+) are all
  understood; rows stream in as batched multi-row `INSERT`s (MySQL has no `COPY`).
  On SQLite, the `INTEGER PRIMARY KEY` rowid alias, type affinity (with `DATETIME`
  / `BOOLEAN` / `JSON` hints honored), and `CHECK (x IN (...))` — the idiomatic
  stand-in for enums — are all understood.
- **Zero install.** One `npx` command against any Postgres, MySQL, or SQLite
  database (SQLite needs no server — just a file).

## Usage

```bash
# Preview the plan — table order, row counts, and sample rows — writing nothing.
npx seedcoherent $DATABASE_URL --rows users=1000 orders=5000 --dry-run

# Insert directly (default). Use --truncate to clear tables first.
npx seedcoherent $DATABASE_URL --rows users=1000 orders=5000 --truncate

# Write a .sql file instead of inserting
npx seedcoherent $DATABASE_URL --rows users=1000 -o seed.sql

# Print SQL to stdout
npx seedcoherent $DATABASE_URL --rows users=100 --print

# No database? Read the schema from a .sql/DDL file and write SQL — nothing to
# connect to. Great for CI or seeding before the database exists.
npx seedcoherent --schema-file schema.sql --rows users=1000 orders=5000 -o seed.sql

# Deterministic output
npx seedcoherent $DATABASE_URL --rows users=100 --seed 42

# Generate in another locale — names, phones, addresses come out German
npx seedcoherent $DATABASE_URL --rows users=1000 --locale de

# Bound the time window — creation timestamps land in [since, until], and
# children still never predate their parents
npx seedcoherent $DATABASE_URL --rows users=1000 orders=5000 \
  --since 2024-01-01 --until 2024-12-31

# Skew a foreign key so a few parents get most of the children (power-law fan-out)
npx seedcoherent $DATABASE_URL --rows users=1000 orders=20000 \
  --distribution orders.user_id=zipf

# Skew a categorical column's values: explicit weights, or a power-law over its
# labels (enum values / CHECK IN set / --column values: list)
npx seedcoherent $DATABASE_URL --rows orders=20000 \
  --distribution 'orders.status=weighted:paid=0.9,shipped=0.07,refunded=0.03' \
  --distribution users.plan=zipf

# Steer specific columns: a faker path, a fixed value, or a pick-list
npx seedcoherent $DATABASE_URL --rows users=1000 \
  --column users.email=internet.email \
  --column users.plan=values:free,pro,enterprise \
  --column users.country=value:Canada
```

Connection string comes from the first argument or `DATABASE_URL`. A
`postgres://`/`postgresql://` URL selects Postgres; a `mysql://` URL selects
MySQL; a `sqlite:`/`file:` URL, `:memory:`, or a bare `.db`/`.sqlite`/`.sqlite3`
path selects SQLite. On Postgres `--schema` defaults to `public`; on MySQL it
defaults to the database named in the connection string; on SQLite it defaults
to `main`.

`--schema-file <path>` skips the connection entirely: it reads a `.sql`/DDL file
(a migration or a `pg_dump`/`mysqldump`/`.schema` dump) and builds the same model
introspection would, so you can generate seed data in CI or before any database
exists. It needs a `-o <file>`/`--print`/`--dry-run` output — there's no database
to insert into — and the live-only modes (`--append`, `--subset`, `--to`,
`--truncate`) don't apply.

`--dialect postgres|mysql|sqlite` (default `postgres`) selects the engine: it
picks both the DDL grammar to parse *and* the flavor of SQL to emit, so a MySQL
schema in gives MySQL seed SQL out. Point it at your own database's schema:

```bash
npx seedcoherent --schema-file schema.sql            --rows users=1000 -o seed.sql  # Postgres DDL → Postgres SQL
npx seedcoherent --schema-file schema.sql --dialect mysql  --rows users=1000 -o seed.sql  # MySQL DDL → MySQL SQL
npx seedcoherent --schema-file schema.sql --dialect sqlite --rows users=1000 -o seed.sql  # SQLite DDL → SQLite SQL
```

To translate across engines — read one dialect's schema and emit another's seed
SQL — add `--schema-dialect <name>` to override the input grammar alone, e.g.
`--schema-dialect postgres --dialect mysql` reads Postgres DDL and writes MySQL.

Each grammar's front-end reuses that engine's live introspector, so an offline
column's category matches a connected one's. All three parse `CREATE TABLE` and
`ALTER TABLE … ADD CONSTRAINT`/`CREATE [UNIQUE] INDEX`, honoring `NOT NULL`,
`DEFAULT`, identity (`SERIAL`, `AUTO_INCREMENT`, the SQLite `INTEGER PRIMARY KEY`
rowid), length/precision, primary/unique/foreign keys, and the CHECK shapes the
live parser reads. Postgres adds `CREATE TYPE … AS ENUM`; MySQL reads inline
`ENUM(...)`, `tinyint(1)` booleans, and `USE <db>`; SQLite honors declared-type
affinity and `CHECK (x IN (...))`. Statements a grammar can't model (extension
types, triggers, views, `SET`, …) are skipped, and any resulting required column
of an unsynthesizable type is reported up front just as it is on a live run.

`--dry-run` reports what a run *would* do — no rows are written:

```
Plan (dry run — nothing was written):

    #  table                  rows
    1  main.categories          10  (cyclic)
    2  main.users             1000
    3  main.products           200
    4  main.orders            5000
    5  main.order_items      15000
                         ─────────
       5 tables              21210

Sample rows:

  main.users
    { id: 1, email: 'larry6@hotmail.com', first_name: 'Virgil', country: 'Montenegro', … }
  main.orders
    { id: 1, user_id: 3, status: 'paid', total: 4972.49, … }
```

### Options

| Flag | Description |
| --- | --- |
| `-r, --rows <table=n...>` | Rows per table, e.g. `users=1000 orders=5000` |
| `-d, --default-rows <n>` | Rows for tables not listed (default: 10) |
| `-s, --seed <n>` | RNG seed for reproducible output |
| `--locale <code>` | Faker locale for generated values (`de`, `fr`, `pt_BR`, `en_GB`, …); defaults to `en_US` (see below) |
| `--batch-size <n>` | Rows per `COPY` batch (default: 10000; does not change output) |
| `--schema <name...>` | Schema(s) to read (default: `public`) |
| `--skip <table...>` | Tables to leave empty |
| `--distribution <col=kind...>` | Skew a column: FK fan-out (`orders.user_id=zipf`, `…=zipf:2`) or a value column's labels (`orders.status=zipf`, `orders.status=weighted:paid=0.9,refunded=0.1`); default `uniform` |
| `-C, --column <col=gen...>` | Override a column's generator, e.g. `users.email=internet.email`, `status=values:active,paid`, or `tier=value:gold` (see below) |
| `-c, --config <path>` | Config file (see below) |
| `--schema-file <path>` | Read the schema from a `.sql`/DDL file instead of a live database (needs `-o`/`--print`/`--dry-run`; see below) |
| `--dialect <name>` | Engine for `--schema-file`: parses that DDL grammar and emits that SQL flavor — `postgres` (default), `mysql`, or `sqlite` |
| `--schema-dialect <name>` | Override the input DDL grammar alone (defaults to `--dialect`), to translate one engine's schema into another's seed SQL |
| `-o, --out <file>` | Write SQL to a file instead of inserting |
| `--print` | Print SQL to stdout |
| `--dry-run` | Preview table order, row counts, and sample rows without writing |
| `--append` | Add rows to a database that already has data (see below) |
| `--truncate` | `TRUNCATE ... RESTART IDENTITY CASCADE` before inserting |
| `--subset <table=n...>` | Subset + anonymize real data (see below) |
| `--to <connection>` | Target DB to insert the anonymized subset into |
| `--anonymize <col...>` | Also scrub these join keys (see below) |
| `--preserve <col...>` | Keep these columns' real values (see below) |
| `--link <group...>` | Scrub denormalized copies to the *same* fake (see below) |

### Locales

By default every generated value is US English. `--locale <code>` switches to
another of [Faker's locales](https://fakerjs.dev/guide/localization.html) —
`de`, `fr`, `ja`, `pt_BR`, `en_GB`, and ~70 more — so names, emails, usernames,
companies, phone numbers, and address parts all come out in that locale:

```bash
npx seedcoherent $DATABASE_URL --rows users=1000 --locale de   # German
npx seedcoherent $DATABASE_URL --rows users=1000 --locale ja   # Japanese
npx seedcoherent --schema-file schema.sql --rows users=1000 --locale pt_BR -o seed.sql
```

A locale that doesn't cover a given category falls back to English rather than
failing, and an unknown code is rejected up front with the list of valid ones.
The same option is a `"locale"` field in the [config file](#config-file).

Intra-row **name** coherence — a row's `full_name`, `email`, and `username` all
deriving from its own first + last name — is locale-aware and applies under every
locale. The US-specific **address** coherence (a `zip` that falls inside its
`state`, a `city` that really sits in it, `country = "United States"`) relies on
en_US's postcode-by-state data, which Faker provides no equivalent of for other
locales, so it applies only to the default and an explicit `en_US`. Under another
locale the `state`/`zip`/`city`/`country` columns are still generated in-locale,
just without that cross-field guarantee. Default (unqualified) runs are unchanged.

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

Add `--dry-run` to preview a subset without writing anywhere: the source is read
and closed over its FK parents (so the counts are exact, not estimated), and the
sample rows are the actual anonymized values that would land in the target.

```bash
npx seedcoherent $PROD_URL --subset orders=500 --dry-run --seed 42
```

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

`--anonymize` keeps *foreign-key* joins consistent, but real schemas often
**denormalize** a value — a user's email copied into `orders.customer_email`,
say — that no foreign key ties back to the source. Scrubbed independently, the
two copies diverge and any informal join on the value breaks. `--link` groups
such columns so they share one mapping: the same original scrubs to the same
fake in every linked column, and distinct originals stay distinct.

```bash
# The user email and its denormalized copy on orders scrub identically.
npx seedcoherent $PROD_URL --subset orders=500 --to $STAGING_URL \
  --link users.email=orders.customer_email

# A bare name links every column called `email` across the schema.
npx seedcoherent $PROD_URL --subset orders=500 --to $STAGING_URL --link email
```

Each `--link` value is one group; its columns are joined by `=` and matched by
the same `table.column` / `schema.table.column` / bare `column` forms. A pattern
may match several columns (a bare `email` links them all), and overlapping
groups merge. `--link` is for *non-key* columns — join keys are already kept
consistent by `--anonymize`, so naming a key column in a link is rejected. The
config file's `link` field takes an array of groups, e.g.
`"link": [["users.email", "orders.customer_email"]]`.

## Append to a database that already has data

A from-scratch run assumes an empty (or truncated) database. `--append` instead
**grows a database you already have** — add more orders to your existing users,
top up a test dataset, or backfill a new table against real ones:

```bash
# Add 5,000 orders that reference the users already in the database.
npx seedcoherent postgres://localhost/mydb --append --rows orders=5000

# Preview it first — existing rows are read to build the FK pools, nothing is written.
npx seedcoherent postgres://localhost/mydb --append --rows orders=5000 --dry-run
```

What append does differently:

- **Only the tables you name in `--rows` grow.** Every other table is left
  untouched (`--default-rows` is ignored — append never writes to a table you
  didn't ask for).
- **Foreign keys reference rows already in the database.** For any parent table
  you are *not* growing, a sample of its existing rows (up to 100k) is read and
  used as the FK pool, so new children point at real existing parents. Grow both
  a parent and its child in the same run and the child references the *new*
  parents instead.
- **Synthetic ids continue past the current max.** A serial/identity/auto-
  increment PK starts at `MAX(id) + 1`, so new rows never collide with existing
  ones. On Postgres the sequence is then reset to the new max, so later
  application inserts stay clean.

`--append` is its own mode: it can't be combined with `--subset` (a different
source→target flow) or `--truncate` (which would delete the data you're
appending to). Uniqueness of *generated* columns is enforced within the run;
collisions against values already in the table are possible for non-synthetic
unique keys, the same best-effort guarantee generation gives elsewhere.

## Config file

Drop a `seed.config.json` next to where you run the command to override
generators or set counts. CLI flags win over the file.

```json
{
  "defaultRows": 50,
  "seed": 42,
  "locale": "de",
  "rows": { "users": 1000, "orders": 5000 },
  "skip": ["audit_log"],
  "columns": {
    "users.email": "internet.email",
    "orders.status": { "values": ["paid", "shipped"] },
    "products.price": { "faker": "commerce.price" }
  },
  "distributions": {
    "orders.user_id": "zipf",
    "order_items.product_id": { "kind": "zipf", "skew": 2 },
    "orders.status": { "kind": "weighted", "weights": [
      { "value": "paid", "weight": 0.9 },
      { "value": "refunded", "weight": 0.1 }
    ] }
  },
  "anonymize": ["accounts.email"],
  "preserve": ["users.country"]
}
```

Column overrides accept a faker path (`"internet.email"`), `{ "faker": "..." }`,
a fixed `{ "value": ... }`, or `{ "values": [...] }` to pick from a list. Keys are
`table.column` or a bare `column` to apply everywhere. The same overrides are
available on the CLI without a config file via `--column`: a bare right-hand side
is a faker path (`users.email=internet.email`), `value:<x>` is a fixed value
(`tier=value:gold`), and `values:<a,b,c>` is a pick-list (`status=values:paid,shipped`).
`value:`/`values:` tokens are JSON-coerced, so `value:30` is the number `30` and
`value:true` is the boolean; anything that isn't valid JSON stays a string.

`distributions` shapes how a column's values spread, keyed by column (same key
forms as `columns`, and matching the `--distribution` flag). On a **foreign-key
column** it controls how children fan out across parents; on a **categorical
value column** (an enum, a `CHECK ... IN (...)` set, or a `values:` override) it
controls how the labels are spread. `"uniform"` (the default) is even; `"zipf"`
skews into a power-law so a few parents — or the first few labels, in declared
order — dominate. `skew` is the Zipf exponent (default `1`, the classic harmonic
law); raise it to concentrate harder, lower it toward uniform. `"weighted"`
assigns explicit relative weights to named values (for a value column only — it
carries its own labels, and is ignored on a foreign key). Referential integrity
is unchanged — every child still points at a real parent.

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
   constraints, and enum types from the catalog (`pg_catalog` on Postgres,
   `information_schema` on MySQL, `PRAGMA` + `sqlite_master` on SQLite). On
   Postgres it also resolves partition strategy + bounds and full type detail
   (arrays, composites, ranges, domains).
2. **Order** — topologically sorts tables so parents populate before children;
   cycles and self-references are broken and handled with a deferred pass.
3. **Infer** — picks a value generator per column from its name and type. The
   introspectors map every dialect's types onto one category set, so inference
   and generation are database-agnostic.
4. **Generate** — builds rows, drawing FK values from already-generated parents
   and de-duplicating uniques.
5. **Emit** — streams rows in dependency order, batched (`--batch-size`) so
   generation never holds the whole dataset in memory, all inside one
   transaction: `COPY ... FROM STDIN` on Postgres, batched multi-row `INSERT` on
   MySQL and SQLite. `--out`/`--print` write a runnable SQL script for the source
   dialect instead.

## Tests

```bash
npm test          # unit tests — no database required
```

The suite covers the pure logic end-to-end: FK topological ordering, name/type
inference and overrides, SQL-literal formatting, config parsing, and seeded
determinism. Because SQLite runs in-process, its integration test (real
introspect → generate → insert, then asserts zero orphan rows) needs no server
and runs as part of `npm test`. The equivalent Postgres integration test runs
only when `DATABASE_URL` is set:

```bash
docker run -d --name pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm test
```

## Status

v0 — Postgres, MySQL, and SQLite, with three modes: generate-from-scratch,
append to an already-populated database, and subset + anonymize real production
data into staging. The schema can come from a live connection or, for
generate-from-scratch, from a Postgres, MySQL, or SQLite `.sql`/DDL file
(`--schema-file --dialect …`) so a run needs no database at all. On the roadmap:
hosted generation.

MySQL and SQLite each target a single database per run (the one in the
connection string / file, or those named via `--schema`); a subset `--to` a
different staging database works because writes are unqualified and land in the
target connection's database. Postgres's richer type detail — arrays,
composites, ranges, domains, partitioning — has no MySQL or SQLite equivalent
and stays Postgres-only; MySQL `CHECK` constraints are read where the server
exposes them (MySQL 8.0.16+ / MariaDB 10.2+) and honored for the numeric-range
and length shapes the parser recognizes.

SQLite is dynamically typed, so a column's category is inferred from its
declared type: semantic names (`DATETIME`, `BOOLEAN`, `JSON`, `UUID`) are
honored first, then SQLite's type-affinity rules. A single-column `INTEGER
PRIMARY KEY` is treated as the auto-assigned rowid. SQLite exposes no catalog
view for `CHECK`s, so they're parsed out of the stored `CREATE TABLE` text —
including `x IN (...)`, the idiomatic stand-in for enums — and honored for the
numeric-range, length, and membership shapes the parser recognizes.

A few Postgres schema shapes are best-effort: single-column `RANGE`/`LIST`
partition keys are constrained to a covered partition, but multi-column,
expression, and hash keys fall back to unconstrained values (fine when a
`DEFAULT` partition or full hash coverage exists). Domain/`CHECK` regexes are
honored for common anchored patterns (character classes, quantifiers, simple
alternation); anything more
exotic (back-references, look-around) is skipped rather than guessed.

## License

MIT
