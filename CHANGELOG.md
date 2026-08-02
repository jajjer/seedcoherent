# Changelog

All notable changes to `seedcoherent` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
