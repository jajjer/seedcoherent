# Changelog

All notable changes to `seedcoherent` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
