# Changelog

All notable changes to `seedcoherent` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
