/** Shared schema + config types used across introspection, inference, and generation. */

export interface ColumnInfo {
  name: string;
  /** Postgres base type name, e.g. "int4", "text", "timestamptz", "_text" (array), enum type name. */
  udtName: string;
  /** Broad category derived from udtName, used for value generation. */
  dataType: string;
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
}

export interface Schema {
  tables: Map<string, TableInfo>;
}

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
  /** Tables to skip entirely. */
  skip?: string[];
  /** RNG seed for deterministic output. */
  seed?: number;
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
}
