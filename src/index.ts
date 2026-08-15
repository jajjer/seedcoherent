/**
 * Programmatic API — the same coherent, referentially-correct generation the CLI
 * performs, but returning the rows in memory instead of writing SQL or inserting.
 *
 *   import { seed } from "seedcoherent";
 *
 *   const { data } = await seed({
 *     schemaFile: "schema.sql",
 *     rows: { users: 100, orders: 500 },
 *     seed: 42,
 *   });
 *   data.users  // -> [{ id: 1, email: "…", … }, …]
 *
 * The schema comes from one of three sources — an inline `ddl` string, a
 * `schemaFile` path, or a live `connection` (introspected read-only). Every
 * generation knob the CLI exposes (rows, seed, locale, since/until, skip,
 * distributions, column overrides) is a field here, and the result can be turned
 * back into a runnable SQL script with `.toSQL()`.
 */

import { readFile } from "node:fs/promises";
import { buildData, requiredUnsupportedColumns, rowCount, type Row, type TableData } from "./generate.js";
import { dialectByName, dialectFor, type Dialect, type DialectName } from "./dialect.js";
import { loadSchemaFromDdl } from "./schema-file.js";
import { topoSort } from "./graph.js";
import { resolveLocale } from "./locale.js";
import { temporalWindow } from "./temporal.js";
import type { ColumnOverride, Config, DistSpec, Schema } from "./types.js";

export type { Row } from "./generate.js";
export type { ColumnOverride, DistSpec } from "./types.js";
export type { DialectName } from "./dialect.js";

/**
 * Where the schema comes from and how to generate against it. Provide exactly
 * one schema source: `ddl` (an inline DDL string), `schemaFile` (a path to a
 * `.sql`/DDL dump), or `connection` (a live database, read-only introspected).
 */
export interface SeedOptions {
  /** Inline DDL (CREATE TABLE …) to parse — no database or file needed. */
  ddl?: string;
  /** Path to a `.sql`/DDL file (a migration or pg_dump/mysqldump/.schema dump). */
  schemaFile?: string;
  /**
   * Live connection string to introspect. Postgres/MySQL/SQLite, selected from
   * the string exactly as the CLI does. The connection is read-only — nothing is
   * written — and closed before `seed` resolves.
   */
  connection?: string;

  /**
   * Engine for `ddl`/`schemaFile`: selects both the DDL grammar to parse and the
   * SQL flavor `.toSQL()` emits. Defaults to `postgres`. Ignored for `connection`
   * (the engine is picked from the connection string).
   */
  dialect?: DialectName;
  /** Override the input DDL grammar alone (defaults to `dialect`). */
  schemaDialect?: DialectName;
  /** Schema(s)/database(s) to read on a live `connection` (default: the engine's). */
  schemas?: string[];

  /** Rows per table, keyed by bare or schema-qualified name: `{ users: 100 }`. */
  rows?: Record<string, number>;
  /** Rows for tables not listed in `rows` (default: 10). */
  defaultRows?: number;
  /** RNG seed for byte-identical output across runs. */
  seed?: number;
  /** Faker locale (`de`, `fr`, `pt_BR`, `en_GB`, …); defaults to US English. */
  locale?: string;
  /** Earliest / latest creation timestamp (ISO date), bounding the time window. */
  since?: string;
  until?: string;
  /** Tables to leave empty. */
  skip?: string[];
  /** Per-column distributions (FK fan-out or categorical label skew). */
  distributions?: Record<string, DistSpec>;
  /** Per-column generator overrides: `{ "users.email": "internet.email" }`. */
  columns?: Record<string, ColumnOverride>;
}

/** One generated table, in dependency (insert-safe) order. */
export interface SeededTable {
  /** Bare table name. */
  name: string;
  /** Owning schema/database. */
  schema: string;
  /** `schema.name` — the canonical key. */
  key: string;
  /** Column names actually populated (DB-assigned identity columns are omitted). */
  columns: string[];
  /** The generated rows. */
  rows: Row[];
}

export interface SeedResult {
  /**
   * Rows keyed by table name for ergonomic access and destructuring:
   * `const { users, orders } = result.data`. Keyed by bare name; a table whose
   * bare name collides across schemas is keyed by its full `schema.name` instead.
   */
  data: Record<string, Row[]>;
  /** Every table in dependency order, with schema/key/columns metadata. */
  tables: SeededTable[];
  /**
   * Render the whole dataset as a runnable SQL script (INSERTs in dependency
   * order). Defaults to the source engine's dialect; pass one to override.
   */
  toSQL(dialect?: DialectName): string;
}

/**
 * Generate coherent rows in memory. Resolves to a {@link SeedResult} — an
 * ergonomic `data` map, an ordered `tables` array, and a `.toSQL()` renderer.
 */
export async function seed(options: SeedOptions): Promise<SeedResult> {
  const sources = [options.ddl, options.schemaFile, options.connection].filter((s) => s != null);
  if (sources.length === 0) {
    throw new Error("seed() needs a schema source: pass one of `ddl`, `schemaFile`, or `connection`.");
  }
  if (sources.length > 1) {
    throw new Error("seed() takes exactly one schema source; `ddl`, `schemaFile`, and `connection` are mutually exclusive.");
  }

  const config: Config = {
    rows: options.rows,
    defaultRows: options.defaultRows,
    columns: options.columns,
    distributions: options.distributions,
    skip: options.skip,
    seed: options.seed,
    locale: options.locale,
    since: options.since,
    until: options.until,
  };

  // Validate the temporal window and locale up front, exactly as the CLI does,
  // so a bad since/until or locale fails before we build (or connect to) anything.
  temporalWindow(config);
  resolveLocale(config.locale);

  const { schema, dialect } = await resolveSchema(options);
  if (schema.tables.size === 0) {
    throw new Error("No tables found in the provided schema.");
  }

  const { order, cyclic } = topoSort(schema);

  // A required column of a type we can't synthesize would make an unrunnable
  // dataset (and an unrunnable INSERT via .toSQL()); surface it now, as the CLI does.
  const skipSet = new Set(config.skip ?? []);
  const genKeys = order
    .filter((t) => !skipSet.has(t.name) && !skipSet.has(t.key) && rowCount(t, config) > 0)
    .map((t) => t.key);
  const unsupported = requiredUnsupportedColumns(schema, config, genKeys);
  if (unsupported.length > 0) {
    const lines = unsupported.map((c) => `  ${c.table}.${c.column} (${c.udtName})`);
    const first = unsupported[0];
    throw new Error(
      [
        `Can't generate a value for ${unsupported.length} NOT NULL column(s) of an unsupported type:`,
        ...lines,
        "",
        `Provide a value — e.g. columns: { "${first.table}.${first.column}": { value: <literal> } } —`,
        "or make the column nullable / give it a DB default.",
      ].join("\n"),
    );
  }

  const materialized = buildData(schema, order, cyclic, config);
  return buildResult(materialized, dialect);
}

/** Obtain a {@link Schema} plus the dialect whose SQL flavor matches the source. */
async function resolveSchema(options: SeedOptions): Promise<{ schema: Schema; dialect: Dialect }> {
  if (options.connection != null) {
    const dialect = dialectFor(options.connection);
    const schemas = options.schemas ?? dialect.defaultSchemas(options.connection);
    const conn = await dialect.connect(options.connection);
    try {
      return { schema: await dialect.introspect(conn, schemas), dialect };
    } finally {
      await conn.end();
    }
  }

  const outputDialect: DialectName = options.dialect ?? "postgres";
  const schemaDialect: DialectName = options.schemaDialect ?? outputDialect;
  let ddl = options.ddl;
  if (ddl == null) {
    try {
      ddl = await readFile(options.schemaFile!, "utf8");
    } catch (err) {
      throw new Error(`Can't read schemaFile ${options.schemaFile}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return { schema: loadSchemaFromDdl(ddl, schemaDialect), dialect: dialectByName(outputDialect) };
}

/** Assemble the public {@link SeedResult} from internal {@link TableData}. */
function buildResult(materialized: TableData[], dialect: Dialect): SeedResult {
  const tables: SeededTable[] = materialized.map((d) => ({
    name: d.table.name,
    schema: d.table.schema,
    key: d.table.key,
    columns: d.columns.map((c) => c.name),
    rows: d.rows,
  }));

  // Key by bare name, but fall back to the schema-qualified key for any bare name
  // that appears in more than one schema, so no table's rows silently overwrite
  // another's.
  const bareCounts = new Map<string, number>();
  for (const t of tables) bareCounts.set(t.name, (bareCounts.get(t.name) ?? 0) + 1);
  const data: Record<string, Row[]> = {};
  for (const t of tables) {
    const key = (bareCounts.get(t.name) ?? 0) > 1 ? t.key : t.name;
    data[key] = t.rows;
  }

  return {
    data,
    tables,
    toSQL(target?: DialectName): string {
      const d = target ? dialectByName(target) : dialect;
      return d.toScript(materialized);
    },
  };
}
