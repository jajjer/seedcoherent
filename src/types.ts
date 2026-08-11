/** Shared schema + config types used across introspection, inference, and generation. */

/**
 * Minimal driver-agnostic query surface. Both the Postgres (`pg`) and MySQL
 * (`mysql2`) clients satisfy this once wrapped, letting introspection and subset
 * fetching stay driver-neutral. Postgres uses `$1` placeholders, MySQL uses `?`,
 * so parameterized SQL is written per-dialect.
 */
export interface Connection {
  // Rows default to `any` so existing raw-catalog queries stay ergonomic; typed
  // call sites (e.g. the MySQL introspector) pass an explicit row shape.
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}

/** A resolved type: its category plus enough to generate/emit a value for it. */
export interface TypeRef {
  udtName: string;
  /** Broad category derived from the type, used for value generation. */
  dataType: string;
  /** For enum types, the allowed labels. */
  enumValues: string[] | null;
}

/** One field of a composite type, in declared order. */
export interface CompositeField extends TypeRef {
  name: string;
}

export interface ColumnInfo {
  name: string;
  /** Postgres base type name, e.g. "int4", "text", "timestamptz", "_text" (array), enum type name. */
  udtName: string;
  /** Broad category derived from udtName, used for value generation. */
  dataType: string;
  /** For array columns, the element type. */
  elementType?: TypeRef;
  /** For composite (row) types, the fields in declared order. */
  compositeFields?: CompositeField[];
  /** For range types, the element (subtype). */
  rangeSubtype?: TypeRef;
  nullable: boolean;
  hasDefault: boolean;
  /** Raw default expression, if any. */
  defaultExpr: string | null;
  /** True for identity/serial columns — we skip these and let the DB assign. */
  isIdentity: boolean;
  /** True for GENERATED ALWAYS AS (...) STORED columns — we must not insert them. */
  isGenerated: boolean;
  /** varchar(n) length limit, if declared. */
  maxLength: number | null;
  /** For enum columns, the allowed labels. */
  enumValues: string[] | null;
  /** numeric(precision, scale), if declared. */
  numericPrecision: number | null;
  numericScale: number | null;
}

export interface ForeignKey {
  /** Columns in this table. */
  columns: string[];
  /** Referenced table (schema-qualified key, e.g. "public.users"). */
  refTable: string;
  /** Referenced columns, positionally aligned with `columns`. */
  refColumns: string[];
}

/** A table-level CHECK constraint, stored as its normalized expression text. */
export interface CheckConstraint {
  /** The expression from `pg_get_expr`, e.g. "(price > (0)::numeric)". */
  expr: string;
}

/**
 * Per-column bounds distilled from CHECK constraints, used to keep generated
 * values inside what the database will accept. Only the patterns we can parse
 * reliably are represented; anything else is left unconstrained.
 */
export interface ColumnCheck {
  /** Allowed value set, from `col IN (...)` / `col = ANY (ARRAY[...])`. */
  in?: (string | number)[];
  /** Inclusive-by-default numeric lower bound. */
  min?: number;
  /** Inclusive-by-default numeric upper bound. */
  max?: number;
  minExclusive?: boolean;
  maxExclusive?: boolean;
  /** Bounds from `char_length(col)` / `length(col)` comparisons. */
  minLength?: number;
  maxLength?: number;
  /** Regex the value must match, from `col ~ '...'` (often a domain CHECK). */
  pattern?: string;
}

/**
 * Partitioning metadata for a partitioned (parent) table. We insert into the
 * parent and let Postgres route rows, but the partition-key value has to land
 * in a partition that actually exists — otherwise the insert is rejected. This
 * captures enough to keep generated key values inside the covered range.
 */
export interface PartitionInfo {
  strategy: "range" | "list" | "hash";
  /** Partition-key column names (empty when the key is an expression). */
  keyColumns: string[];
  /** True when a DEFAULT partition exists — any key value routes somewhere. */
  hasDefault: boolean;
  /**
   * RANGE partitions' covered intervals for the (first) key column, as raw
   * bound literals. `null` means unbounded (MINVALUE/MAXVALUE).
   */
  ranges?: Array<{ from: string | null; to: string | null }>;
  /** LIST partitions' union of accepted values for the (first) key column. */
  list?: string[];
}

export interface TableInfo {
  schema: string;
  name: string;
  /** "schema.name" — the canonical key used throughout. */
  key: string;
  columns: ColumnInfo[];
  primaryKey: string[];
  /** Each unique constraint is a set of column names. */
  uniques: string[][];
  foreignKeys: ForeignKey[];
  /** Table CHECK constraints, as raw expression text (parsed in checks.ts). */
  checks: CheckConstraint[];
  /** Set when this table is a partitioned parent (relkind 'p'). */
  partition?: PartitionInfo;
}

export interface Schema {
  tables: Map<string, TableInfo>;
}

/**
 * How draws spread across a set of choices. Used in two roles that share the
 * same "lopsidedness" idea:
 *
 *  - **Foreign keys** — how child rows choose their parent. `uniform` (the
 *    default) picks any parent equally; `zipf` skews the choice so a few parents
 *    collect many children and most collect few.
 *  - **Value columns** — how a categorical column spreads over its labels (an
 *    enum's values, a `CHECK ... IN (...)` set, or a `values:` override). Real
 *    `status`/`plan`/`tier` columns are lopsided too — mostly `active`, a sliver
 *    `banned` — not the even split a uniform draw gives.
 *
 * `zipf` weights choice `k` (1-based, in declared order) by `1/k**skew`. `skew`
 * defaults to 1 (classic harmonic Zipf); higher concentrates harder, lower
 * flattens toward uniform. `weighted` assigns explicit relative weights to named
 * values — it carries its own value set, so it applies to any column regardless
 * of type and is ignored on foreign keys (parents have no labels). Weights are
 * relative and need not sum to 1.
 */
export type DistSpec =
  | "uniform"
  | "zipf"
  | { kind: "uniform" }
  | { kind: "zipf"; skew?: number }
  | { kind: "weighted"; weights: Array<{ value: unknown; weight: number }> };

/** Per-column override supplied by the user via config. */
export type ColumnOverride =
  | string // a faker path like "internet.email" or "person.firstName"
  | { faker: string }
  | { value: unknown }
  | { values: unknown[] }; // pick uniformly from this list

export interface Config {
  /** Rows per table, keyed by table name (bare or schema-qualified). */
  rows?: Record<string, number>;
  /** Default row count for tables not listed in `rows`. */
  defaultRows?: number;
  /** Per-column generator overrides: { "users.email": "internet.email" }. */
  columns?: Record<string, ColumnOverride>;
  /**
   * Per-column distributions, keyed by column. On a foreign-key column it shapes
   * parent selection ({ "orders.user_id": "zipf" } — how many children each
   * parent collects); on a categorical value column it shapes the label spread
   * ({ "orders.status": "weighted:..." } — mostly `paid`, a few `refunded`).
   * Defaults to `uniform` for anything not listed. Keyed by "table.column",
   * "schema.table.column", or bare "column".
   */
  distributions?: Record<string, DistSpec>;
  /** Tables to skip entirely. */
  skip?: string[];
  /** RNG seed for deterministic output. */
  seed?: number;
  /**
   * Temporal coherence window (ISO date/timestamp). Creation timestamps are
   * drawn within [since, until]; a child's creation time is never earlier than
   * its parents'. Defaults: `until` is the seeded reference date (or now for an
   * unseeded run) and `since` is two years before it.
   */
  since?: string;
  until?: string;
  /** Rows per COPY batch / streaming-generation chunk. Does not affect output. */
  batchSize?: number;
  /**
   * Subset+anonymize only: columns to scrub even though they are join keys
   * (primary keys, FK columns, or columns an FK references). Naming any one
   * column of a join group anonymizes the whole group consistently, so FKs
   * still resolve. Keyed by "table.column", "schema.table.column", or bare
   * "column".
   */
  anonymize?: string[];
  /**
   * Subset+anonymize only: columns to pass through verbatim even though they
   * would normally be scrubbed. Same key forms as `anonymize`.
   */
  preserve?: string[];
  /**
   * Subset+anonymize only: groups of non-key columns that hold the *same* real
   * value (a denormalized copy) and must therefore scrub to the *same* fake.
   * Each group is a list of column patterns; the whole group shares one value
   * mapping, so e.g. a user's email copied into `orders.customer_email`
   * anonymizes identically in both — informal joins on the value survive. A
   * pattern may match several columns (a bare `email` links every `email`
   * column). Join keys are handled by `anonymize`, not here, so a group naming
   * a key column is rejected. Same key forms as `anonymize`.
   */
  link?: string[][];
}
