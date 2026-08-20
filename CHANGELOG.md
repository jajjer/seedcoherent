# Changelog

All notable changes to `seedcoherent` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.18.0] — 2026-08-20

### Added

- **`--profile` learns the shape of an existing database and generates data to
  match it — no more hand-tuning every knob.** The distribution, null-rate, and
  temporal flags each bend generated data toward production, but only once you've
  measured production and typed each number in yourself. `--profile` measures it
  for you: pointed at a *populated* database, it samples the existing rows right
  after reading the schema and derives the matching config — the real per-column
  `NULL` fraction of every nullable column; the observed value spread of every
  low-cardinality categorical column (an enum, a boolean, a `status`/`plan`), as a
  `weighted` distribution; the foreign-key fan-out skew, emitted as a `zipf`
  distribution when the children-per-parent spread follows a power law (fitted by
  least-squares on the log rank/frequency curve) and left `uniform` when it
  doesn't; and the real min/max of creation timestamps as the `--since`/`--until`
  window. It then generates fresh, fully synthetic rows shaped like that — "make
  me 100k rows that look like production, but fake" is one flag. High-cardinality
  columns (emails, names, ids) are never weighted, so no real values leak into the
  output. Profiling is **read-only** (aggregate `SELECT`s only; it never writes to
  the source) and layers *beneath* your own settings — any `--distribution`,
  `--null-rate`, `--since`/`--until`, `--column`, or config-file entry you pass
  wins, and profiling fills only what you left unspecified. It composes with
  `--append` and works on Postgres, MySQL, and SQLite; it's rejected against
  `--schema-file` (no data to read) and `--subset` (a different mode). A companion
  `--profile-out <file>` writes the derived config to JSON and exits without
  generating, so the inferred shape is inspectable, editable, and reusable later
  via `--config` — even offline against a `--schema-file`. Unseeded runs stay
  byte-identical for anyone not opting in.

## [0.17.0] — 2026-08-18

### Added

- **`--null-rate` controls how often a nullable column is left `NULL`, per
  column.** Nullable columns were nulled at a single fixed rate for every column,
  so generated data lost the shape real tables have — a `deleted_at` that's empty
  on nearly every live row, an optional `middle_name` present maybe a third of
  the time, a `notes` column that's always filled. `--null-rate <col>=<0..1>` now
  sets that fraction per column: `--null-rate users.middle_name=0.7
  orders.deleted_at=1 users.notes=0` leaves 70% of middle names empty, every
  `deleted_at` `NULL`, and every `notes` populated. Columns are matched by
  `table.column`, `schema.table.column`, or a bare `column` — the same precedence
  `--distribution` and `--column` use — and the rate applies only where a `NULL`
  is already valid: `NOT NULL`, primary-key/unique, partition-key, and
  foreign-key columns are untouched (an FK still points at a real parent). The
  same knob is a `nullRates` map in the config file and a `nullRates` field on the
  programmatic `seed()` API; out-of-range rates are rejected up front alongside
  the existing temporal/locale validation. A run that configures no rate is
  byte-identical to before under `--seed`, so nothing changes for anyone not
  opting in.

## [0.16.0] — 2026-08-15

### Added

- **A programmatic API returns the generated rows in memory — no subprocess, no
  files.** Everything was CLI-only: the sole way to get rows out was to shell out
  and read back a SQL script, CSV, or NDJSON. `seedcoherent` now ships a Node/
  TypeScript entry point, so a test suite can `import { seed }` and get the same
  coherent, referentially-correct rows as data:

  ```ts
  import { seed } from "seedcoherent";

  const { data } = await seed({
    ddl: schemaString,           // or schemaFile: "schema.sql", or connection: "postgres://…"
    rows: { users: 100, orders: 500 },
    seed: 42,
  });
  data.users;  // -> [{ id: 1, email: "…", first_name: "…", … }, …]
  ```

  The schema comes from one of three mutually-exclusive sources — an inline `ddl`
  string, a `schemaFile` path, or a live `connection` (introspected read-only and
  closed before the call resolves). Every generation knob the CLI has is a field:
  `rows`, `defaultRows`, `seed`, `locale`, `since`/`until`, `skip`,
  `distributions`, and per-column `columns` overrides, plus `dialect`/
  `schemaDialect`/`schemas`. The result carries an ergonomic `data` map (keyed by
  table name for destructuring — schema-qualified only when a bare name collides
  across schemas), an ordered `tables` array with schema/key/column metadata, and
  a `toSQL(dialect?)` method that renders the dataset as a runnable script in any
  of the three SQL flavors. The same up-front validation the CLI does (temporal
  window, locale, unsynthesizable required columns) throws before any rows are
  built. The package now exposes `main`/`types`/`exports`; the CLI is unchanged.

## [0.15.0] — 2026-08-13

### Added

- **`--format csv|ndjson` writes the generated data as plain files, not SQL.**
  Every mode's `-o`/`--print` path produced a runnable SQL script — the only way
  to get rows out was through a database's SQL dialect. `--format csv` and
  `--format ndjson` now emit the data itself instead: CSV with an RFC-4180 header
  row, or newline-delimited JSON, so the same coherent, referentially-correct
  rows can feed a spreadsheet, a data lake, a `COPY FROM`, or a language-native
  test fixture with no database in the loop. Because CSV is inherently one table
  per file, both formats write **one file per table** into the directory passed
  as `-o` (`./seed/users.csv`, `./seed/orders.csv`), created if missing and
  schema-qualified in the filename only when a bare table name would collide.
  Serialization is identical whatever the source engine (Postgres, MySQL,
  SQLite): timestamps become ISO-8601, binary becomes base64, and `json`/array
  columns stay native JSON in NDJSON / a compact JSON string in CSV. Since these
  formats produce files, the database-only destinations (`--print`, `--to`,
  direct insert, `--truncate`) are rejected up front with a pointer to
  `-o <dir>`. Works with generate, `--schema-file`, `--append`, and `--subset`
  alike, and is also a `format` field in the config file. The default,
  `--format sql`, is byte-identical to before.

## [0.14.0] — 2026-08-13

### Added

- **`--locale <code>` generates values in a language/region other than US
  English.** Every generated value already came from Faker, but always in its US
  English locale — so a German or Japanese schema still got American names,
  US-format phone numbers, and English country names. `--locale de` (or `fr`,
  `pt_BR`, `en_GB`, … — any of Faker's 70-plus locales) now drives names, emails,
  usernames, companies, phone numbers, and address parts in that locale, with
  English as a fallback for any category a locale doesn't cover. Also available
  as a `locale` field in the config file, and validated up front so an unknown
  code fails before connecting, listing the valid ones. Intra-row **name**
  coherence (a row's `full_name`/`email`/`username` deriving from its own first +
  last name) is locale-aware and applies everywhere. The US-specific **address**
  coherence — a `zip` that falls inside its `state`, a `city` that really sits in
  it, `country = "United States"` — relies on en_US's postcode-by-state data,
  which Faker has no equivalent of for other locales, so it applies only to the
  default and an explicit `en_US`; under another locale the address columns are
  still generated in-locale but without that cross-field guarantee. Default
  (unqualified) runs are byte-identical to before.

## [0.13.0] — 2026-08-11

### Added

- **`--link` keeps denormalized copies consistent through anonymization.**
  Subset+anonymize already remaps *foreign-key* join groups consistently (both
  sides of an FK move together via `--anonymize`), but real schemas often carry
  a value no foreign key ties back to its source — a user's email copied into
  `orders.customer_email`, a status duplicated across tables. Scrubbed
  independently, those copies diverged, breaking any informal join on the value.
  `--link users.email=orders.customer_email` (repeatable; each flag value is one
  `=`-joined group) now groups such columns so they share a single value
  mapping: the same original scrubs to the same fake in every linked column, and
  distinct originals stay distinct. A pattern may match many columns (a bare
  `--link email` links every `email` column) and overlapping groups merge. Join
  keys stay the province of `--anonymize`, so a link naming a key column is
  rejected with a pointer to it. Also available as a `link` array-of-groups in
  the config file.

## [0.12.0] — 2026-08-05

### Added

- **JSON/JSONB columns now generate name-shaped structures, not one opaque
  stub.** A live database only tells us a column is `json`; its *name* is the
  only hint about what it holds — exactly as with scalar columns. So the
  generator now reads the name: an `address` column gets a structured
  `{street, city, state, zip, country}`, `tags`/`labels` get a JSON string
  array, `permissions`/`scopes` a role array, `settings`/`preferences` a small
  `{theme, language, notifications}` object, `geo`/`coordinates` a `{lat, lng}`
  pair, `dimensions` a `{width, height, unit}`, `contact` an `{email, phone}`,
  `pricing` an `{amount, currency}`, and `profile` a `{bio, avatar, website}`.
  Anything unrecognized falls through to a generic attribute bag. This extends
  the tool's "column names drive realistic content" identity to structured
  columns, which previously all got the same `{id, value}` placeholder.

### Fixed

- **A JSON column holding an array now emits a JSON array, not a Postgres
  array.** On the Postgres emitters (both the multi-row `INSERT` and the
  streaming `COPY` path) a JavaScript array was formatted as a Postgres array
  literal `{"a","b"}` regardless of column type — invalid for a `jsonb` column,
  which needs `["a","b"]::jsonb`. The emitter now checks the column's json
  category before its array-literal branch, so a `jsonb` array column
  serializes as JSON. (MySQL and SQLite were already correct, having no
  Postgres-style array type.)

## [0.11.0] — 2026-08-02

### Added

- **`--schema-file` now reads MySQL and SQLite DDL, not just Postgres.** The
  offline front-end used to parse only Postgres DDL (`--dialect` chose the output
  flavor but the input was always Postgres). `--dialect` is now the *engine*: it
  selects both the DDL grammar to parse and the SQL flavor to emit, so a MySQL
  schema in gives MySQL seed SQL out and a SQLite schema gives SQLite — matching
  the tool's "three databases, one tool" identity for the no-database path too.
  Each grammar has a hand-rolled `CREATE TABLE` / `ALTER TABLE … ADD CONSTRAINT`
  / `CREATE [UNIQUE] INDEX` parser that reuses that engine's live introspector,
  so an offline column's category matches a connected one's: MySQL reads
  backtick identifiers, `AUTO_INCREMENT`, inline `ENUM(...)`, `tinyint(1)`
  booleans, `DECIMAL(p,s)`, `USE <db>`, and table options; SQLite reads
  `AUTOINCREMENT`, the `INTEGER PRIMARY KEY` rowid alias, bracket/quoted
  identifiers, declared-type affinity, and the `CHECK (x IN (...))` enum idiom.
  Statements a grammar can't model (triggers, views, `SET`, extension types, …)
  are skipped rather than aborting the file, exactly as on the Postgres path.
- **`--schema-dialect <name>`** overrides the input DDL grammar alone (it
  defaults to `--dialect`), for the rarer case of translating one engine's
  schema into another's seed SQL — e.g. `--schema-dialect postgres --dialect
  mysql` reads Postgres DDL and writes MySQL.

## [0.10.0] — 2026-08-02

### Added

- **Generate from a schema file — no database required.** The new
  `--schema-file <path>` flag reads a Postgres `.sql`/DDL file (a migration or a
  `pg_dump --schema-only` dump) and builds the same internal model introspection
  would, then writes generated SQL with `-o`/`--print` (or previews with
  `--dry-run`). Until now every run needed a live connection to introspect; you
  can now seed in CI or before the database exists. It parses `CREATE TABLE`,
  `CREATE TYPE … AS ENUM`, and `ALTER TABLE … ADD CONSTRAINT`, honoring `NOT
  NULL`, `DEFAULT`, `SERIAL`/identity and generated columns, `varchar(n)` /
  `numeric(p,s)`, primary/unique/foreign keys, and the CHECK shapes the live
  parser already reads (numeric ranges, `IN (...)`, `BETWEEN`, `char_length`).
  `--dialect postgres|mysql|sqlite` (default `postgres`) selects the emitted SQL
  flavor. Statements it can't model (`CREATE DOMAIN`, extension types, `SET`,
  `COMMENT`, …) are skipped rather than aborting the file, and a required column
  left of an unsynthesizable type is reported up front — exactly as on a live
  run. The live-only modes (`--append`, `--subset`, `--to`, `--truncate`) are
  rejected with a clear message since they inherently need a database.

## [0.9.0] — 2026-08-01

### Added

- **`money`, `interval`, `macaddr`/`macaddr8`, and `xml` columns now generate
  real values.** In 0.8.1 these types stopped *crashing* the run — a `NOT NULL`
  one with no default still hard-stopped it, telling you to pass `--column`.
  They're now first-class: `money` gets a plausible amount, `interval` a random
  day-plus-time span, `macaddr` a six-octet hardware address (widened to
  `macaddr8` when the column calls for it), and `xml` a well-formed record
  element. Each emits a textual literal Postgres coerces to the column type, so
  it flows through both the multi-row-`INSERT` and streaming-`COPY` paths
  unchanged and needs no `--column` override. Types that genuinely have no safe
  default literal — `tsvector`, `bit`/`varbit`, PostGIS `geometry`, and other
  extension types — stay `unsupported` and are handled exactly as before (NULL a
  nullable column, skip a defaulted one, flag a required one up front). Output
  for every schema without one of these four column types is byte-identical.

## [0.8.1] — 2026-07-30

### Fixed

- **Unsupported column types no longer crash the whole run.** A type the
  generator doesn't recognize (`money`, `interval`, `tsvector`, PostGIS
  `geometry`, `macaddr`, `bit`, `xml`, spatial types, …) was silently treated as
  `text` and filled with lorem words the `INSERT` rejects — rolling back the
  entire transaction to zero rows with a raw database error. Such types are now
  categorized `unsupported` and handled safely per column: a nullable one gets
  `NULL`, one with a DB default is left out of the `INSERT` so the database fills
  it, and a `--column` override is honored as before. A `NOT NULL` column with no
  default, override, or foreign key to draw from is reported **up front** — with
  the exact `--column` flag to fix it — instead of failing mid-transaction.
  Applies to Postgres and MySQL; SQLite is dynamically typed and was unaffected.

## [0.8.0] — 2026-07-30

### Added

- **Weighted value distributions.** The `--distribution` flag — until now a
  foreign-key-only knob for parent fan-out — also shapes a *categorical column's
  own values*. `--distribution orders.status=weighted:paid=0.9,refunded=0.1`
  gives explicit relative weights (they need not sum to 1), so 90% of orders come
  out `paid`; `--distribution users.plan=zipf` applies a power-law over the
  column's inferred label set (an enum's values, a `CHECK ... IN (...)` set, or a
  `--column values:` list) in declared order, so the first label dominates and
  the rest thin out. This replaces the dead-even split a uniform draw gives —
  `GROUP BY status`, "mostly-active" cohorts, and top-N-by-category queries now
  behave like production. A column is either a foreign key (fan-out) or a value
  column (label spread), so the same flag reads naturally in both roles; a
  `weighted:` spec on a foreign key degrades to uniform (parents have no labels).
  The distribution machinery is shared with the FK path, and a value
  distribution only reshapes columns you opt in — every other column's seeded
  output is byte-identical to before.

## [0.7.0] — 2026-07-30

### Added

- **City coherence.** A row's `city` now sits inside its own `state`, completing
  the address block started in 0.6.0. When a table has a `state` alongside a
  `city` (and/or a `zip`), the city is drawn from a curated set of real cities in
  that state — so a Texas row gets Houston or Austin, never San Francisco — with
  `country` still reading `United States`. Address coherence now triggers on a
  `state` plus *either* a `zip` or a `city`, so a `city`/`state` pair with no zip
  column coheres too. `billing_*` and `shipping_*` blocks stay independent, pinned
  columns still anchor their group, and Faker's own (state-unaware) city data is
  the fallback for the rare uncovered territory. This changes seeded output only
  for schemas with a city (or newly a zip-less state) column; every other schema's
  output is byte-identical to before.
- **MySQL integration test + CI.** A live MySQL end-to-end test (opt-in via
  `MYSQL_URL`) now exercises the full introspect → generate → insert pipeline and
  verifies referential integrity, uniqueness, and the MySQL-specific column shapes
  (`AUTO_INCREMENT`, `ENUM`, `tinyint(1)` booleans, `JSON`, `CHECK`). CI spins up a
  `mysql:8` service and runs it alongside the existing Postgres integration suite,
  so MySQL is no longer covered only by off-database unit tests.

## [0.6.0] — 2026-07-29

### Added

- **Intra-row value coherence.** A row's name and address fields now agree with
  each other instead of being drawn independently. When a table has both a
  `first_name` and a `last_name`, its `full_name`/`display_name`, `email`, and
  `username` are derived from that same name (so the email actually belongs to
  the person), and a `gender`/`sex` column biases the first name. When a table
  has both a `state` and a `zip`, the zip is a real postal code inside that state
  and a `country` column reads `United States` — no more California zip codes in
  Texas rows. Columns are grouped by name prefix, so `billing_*` and `shipping_*`
  (or `contact_*`) blocks stay independent. A column pinned with `--column` still
  anchors the rest of its group (a fixed `first_name` drives the derived email),
  and foreign-key, partition-key, and intentionally-null columns are left
  untouched. State values are emitted as their two-letter abbreviation (the form
  that pairs with a zip). This changes seeded output for schemas with these
  columns. Coherence draws come from a dedicated US locale, so every other
  column's seeded output is byte-identical to before.

## [0.5.0] — 2026-07-29

### Added

- **Temporal coherence.** Generated date/timestamp columns are now causal
  instead of independent. A row's activity/expiry columns (`updated_at`,
  `last_login`, `last_seen`, `modified_at`, `deleted_at`, `expires_at`) never
  precede its creation column (`created_at`, `inserted_at`, `registered_at`,
  `first_seen`), and a child row's creation time is never earlier than the
  creation time of any parent it references by foreign key — so `orders.created_at`
  always lands after the `users.created_at` of its user. Creation timestamps are
  drawn inside a window controlled by the new `--since` / `--until` flags (ISO
  dates; `until` defaults to the seeded reference date `2025-01-01`, or now for an
  unseeded run, and `since` defaults to two years earlier). Expiry/deletion
  columns may run past `until`, since those legitimately point at the future.
  Works in append mode too: appended children reference the real creation times
  of the existing parents they attach to. A column pinned with `--column` (or a
  partition-key column) is left untouched. This changes seeded output for schemas
  with date/timestamp columns.

## [0.4.0] — 2026-07-29

### Added

- `--append` grows a database that **already holds data** instead of generating
  from scratch. Only the tables named via `--rows` get new rows; every foreign
  key that points at a table you are *not* growing is filled from rows already in
  the database (a sample of up to 100k existing parents), so new children
  reference real existing parents. Synthetic integer PKs continue past the
  current `MAX(id)` rather than restarting at 1, so new rows never collide with
  existing ones — and on Postgres the serial/identity sequence is reset to the
  new max afterward, so later app inserts stay clean. Works with `--dry-run`
  (existing rows are read to build the preview, nothing is written) and with
  `--out`/`--print`. Rejected together with `--subset` or `--truncate`.

## [0.3.0] — 2026-07-28

### Added

- `--column` (`-C`) exposes per-column generator overrides on the CLI — no
  config file needed. A bare value is a faker path
  (`--column users.email=internet.email`), `value:<x>` pins a constant
  (`--column tier=value:gold`), and `values:<a,b,c>` picks uniformly from a list
  (`--column status=values:paid,shipped`). `value:`/`values:` tokens are
  JSON-coerced, so `value:30` is a number and `value:true` a boolean. Repeatable,
  and merged with (overriding) any `columns` entries from a config file — the
  same relationship `--rows`/`--distribution` already have with the config file.

### Fixed

- Removed stray literal control-character bytes (NUL `0x00` and SOH `0x01`) from
  `src/generate.ts`, `src/subset.ts`, and `test/subset.test.ts` — null-value
  sentinels and uniqueness-key separators written as raw control characters. They
  are now the equivalent `"\u0000"` / `"\u0001"` escapes, byte-identical at
  runtime, so the files are plain text (`grep`/`rg` no longer skip them and
  `git`/`file` no longer treat them as binary). No behavior change.

## [0.2.0]

### Added

- `--dry-run` now works with `--subset`. Previously it errored out; it now reads
  the source, closes over the foreign-key graph, and prints the exact per-table
  counts plus a few of the actual anonymized sample rows — all without writing to
  the target (or the source).

## [0.1.0]

### Added

- `--dry-run` previews a run without writing: it prints the table order,
  per-table row counts, the grand total, and a few seeded sample rows per table
  so you can sanity-check the plan before pointing the tool at a real database.
- Name-based value inference now covers **numeric** columns. Columns like `age`,
  `birth_year`, `quantity`, `rating`, `score`, `discount_percent`, `count`, and
  money columns (`price`, `amount`, `total`, …) get realistic ranges instead of
  the generic `0..1,000,000` fallback. Money columns honor the column's numeric
  scale; integer-typed money columns round to whole numbers.
- `npm run benchmark` — a throughput harness that generates and inserts a large
  row set across the demo schema into a throwaway SQLite database and reports
  rows/sec. Pass `--scale <n>` to multiply the workload.

## [0.0.2]

### Fixed

- CLI help text now mentions SQLite alongside Postgres and MySQL.

### Added

- `LICENSE` (MIT) and package metadata for npm/GitHub discoverability.

## [0.0.1]

- Initial release: schema-aware, referentially-correct synthetic data generation
  for Postgres, MySQL, and SQLite; subset + anonymize mode; skewed FK fan-out
  distributions; streaming inserts.
