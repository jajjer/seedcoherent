/**
 * Builds coherent rows table-by-table in dependency order: FK columns are
 * filled from parent rows that already exist, uniques/PKs are de-duplicated,
 * and self-referential tables reference earlier rows in the same batch.
 */

import { Faker, en } from "@faker-js/faker";
import { inferGenerator, partitionKeyGenerator, type Generator } from "./infer.js";
import { parseChecks } from "./checks.js";
import { DEFAULT_BATCH_SIZE } from "./config.js";
import type { Config, ColumnInfo, Schema, TableInfo } from "./types.js";

export type Row = Record<string, unknown>;

export interface TableData {
  table: TableInfo;
  rows: Row[];
  /** Columns actually emitted (excludes generated/identity-without-value). */
  columns: ColumnInfo[];
}

/** One contiguous chunk of rows for a table, as produced by `streamData`. */
export interface Batch {
  table: TableInfo;
  /** Columns actually emitted (excludes generated/identity-without-value). */
  columns: ColumnInfo[];
  rows: Row[];
  /** True on the final batch for a table (may itself be empty). */
  last: boolean;
}

/**
 * Consumes batches of generated rows. `begin`/`write`/`end` bracket each table
 * in `order`; `finalize` runs once after the last table. Methods may be async
 * so a sink can apply backpressure (e.g. a streaming COPY into Postgres).
 */
export interface RowSink {
  begin(table: TableInfo, columns: ColumnInfo[]): void | Promise<void>;
  write(rows: Row[]): void | Promise<void>;
  end(): void | Promise<void>;
  finalize?(tables: TableInfo[]): void | Promise<void>;
}

/** Per-table row count, returned by `generateInto` for the run summary. */
export interface TableStats {
  table: TableInfo;
  rows: number;
}

const NULL_PROBABILITY = 0.08;
const UNIQUE_RETRIES = 25;

function rowCount(table: TableInfo, config: Config): number {
  const byName = config.rows?.[table.name] ?? config.rows?.[table.key];
  return byName ?? config.defaultRows ?? 10;
}

/** Is this column served by a foreign key? Returns the FK + its position. */
function fkForColumn(table: TableInfo, colName: string) {
  for (const fk of table.foreignKeys) {
    const idx = fk.columns.indexOf(colName);
    if (idx !== -1) return { fk, idx };
  }
  return null;
}

/** Should we let the DB assign this column rather than generate a value? */
function isDbAssigned(col: ColumnInfo): boolean {
  return col.isGenerated;
}

/**
 * Generates rows table-by-table in dependency order, yielding them in batches
 * of at most `batchSize`. Exactly one batch per non-skipped table is flagged
 * `last` (possibly empty), so consumers can bracket each table even when it
 * produces no rows. The faker call sequence is independent of `batchSize`, so
 * seeded output is byte-identical regardless of batching.
 */
export function* streamData(
  schema: Schema,
  order: TableInfo[],
  cyclic: Set<string>,
  config: Config,
  batchSize: number = DEFAULT_BATCH_SIZE,
): IterableIterator<Batch> {
  const faker = new Faker({ locale: [en] });
  if (config.seed !== undefined) {
    faker.seed(config.seed);
    // Date generators reference "now" by default; pin it so seeded runs are
    // fully reproducible.
    faker.setDefaultRefDate("2025-01-01T00:00:00.000Z");
  }

  const skip = new Set(config.skip ?? []);
  const generated = new Map<string, Row[]>(); // table.key -> rows (for FK lookups)

  for (const table of order) {
    if (skip.has(table.name) || skip.has(table.key)) continue;

    const emitCols = table.columns.filter((c) => !isDbAssigned(c));
    // Distill CHECK constraints into per-column bounds the generators honor.
    const checks = parseChecks(table.checks);
    // Pre-resolve a generator per non-FK column.
    const gens = new Map<string, Generator>();
    for (const col of emitCols) {
      if (!fkForColumn(table, col.name)) {
        // A partition-key column must stay inside an existing partition, else the
        // parent-table insert has nowhere to route the row.
        const partGen = table.partition ? partitionKeyGenerator(col, table.partition) : null;
        gens.set(col.name, partGen ?? inferGenerator(table, col, config.columns, checks.get(col.name)));
      }
    }

    const count = rowCount(table, config);
    // Full row history for this table, needed for self-referential FK draws and
    // to seed the `generated` pool other tables draw from.
    const rows: Row[] = [];
    let pending: Row[] = [];
    // Track seen tuples per unique constraint (PK included).
    const uniqueSets = [table.primaryKey, ...table.uniques].filter((u) => u.length > 0);
    const seen = uniqueSets.map(() => new Set<string>());

    let idCounter = 1;
    for (let i = 0; i < count; i++) {
      let row: Row | null = null;

      for (let attempt = 0; attempt < UNIQUE_RETRIES; attempt++) {
        const candidate: Row = {};
        for (const col of emitCols) {
          candidate[col.name] = valueForColumn(
            table,
            col,
            gens,
            faker,
            generated,
            rows,
            i,
            cyclic,
            () => idCounter,
          );
        }
        // Check every unique constraint.
        const keys = uniqueSets.map((cols) => cols.map((c) => serializeKey(candidate[c])).join(""));
        const collision = keys.some((k, idx) => seen[idx].has(k));
        if (!collision) {
          keys.forEach((k, idx) => seen[idx].add(k));
          row = candidate;
          break;
        }
      }

      if (!row) break; // couldn't satisfy uniqueness (e.g. exhausted junction combos)
      // Advance the synthetic id counter only for rows we keep.
      if (usesSyntheticId(table)) idCounter++;
      rows.push(row);
      pending.push(row);
      if (pending.length >= batchSize) {
        yield { table, columns: emitCols, rows: pending, last: false };
        pending = [];
      }
    }

    generated.set(table.key, rows);
    // Always emit a final batch (even if empty) so consumers can bracket the
    // table and record it, matching buildData's one-entry-per-table output.
    yield { table, columns: emitCols, rows: pending, last: true };
  }
}

export function buildData(
  schema: Schema,
  order: TableInfo[],
  cyclic: Set<string>,
  config: Config,
): TableData[] {
  const result: TableData[] = [];
  let current: TableData | null = null;
  // One unbounded batch per table keeps this a simple regrouping of streamData.
  for (const batch of streamData(schema, order, cyclic, config, Infinity)) {
    if (!current || current.table !== batch.table) {
      current = { table: batch.table, rows: [], columns: batch.columns };
      result.push(current);
    }
    if (batch.rows.length) current.rows.push(...batch.rows);
  }
  return result;
}

/**
 * Drives a {@link RowSink} with generated rows, bracketing each table with
 * `begin`/`end` and streaming its rows through `write` in `batchSize` chunks.
 * Returns per-table kept-row counts for the run summary.
 */
export async function generateInto(
  schema: Schema,
  order: TableInfo[],
  cyclic: Set<string>,
  config: Config,
  sink: RowSink,
  batchSize: number = DEFAULT_BATCH_SIZE,
): Promise<TableStats[]> {
  const stats: TableStats[] = [];
  let currentTable: TableInfo | null = null;
  let count = 0;

  for (const batch of streamData(schema, order, cyclic, config, batchSize)) {
    if (batch.table !== currentTable) {
      await sink.begin(batch.table, batch.columns);
      currentTable = batch.table;
      count = 0;
    }
    if (batch.rows.length) {
      await sink.write(batch.rows);
      count += batch.rows.length;
    }
    if (batch.last) {
      await sink.end();
      stats.push({ table: batch.table, rows: count });
      currentTable = null;
    }
  }

  await sink.finalize?.(order);
  return stats;
}

/** A {@link RowSink} that materializes every batch back into `TableData[]`. */
export class CollectSink implements RowSink {
  readonly data: TableData[] = [];
  private current: TableData | null = null;

  begin(table: TableInfo, columns: ColumnInfo[]): void {
    this.current = { table, rows: [], columns };
    this.data.push(this.current);
  }

  write(rows: Row[]): void {
    this.current?.rows.push(...rows);
  }

  end(): void {
    this.current = null;
  }
}

/** A single-column integer PK with a DB default/identity → we assign 1..N. */
function usesSyntheticId(table: TableInfo): boolean {
  if (table.primaryKey.length !== 1) return false;
  const col = table.columns.find((c) => c.name === table.primaryKey[0]);
  return !!col && (col.isIdentity || col.hasDefault) && col.dataType === "integer";
}

function valueForColumn(
  table: TableInfo,
  col: ColumnInfo,
  gens: Map<string, Generator>,
  faker: Faker,
  generated: Map<string, Row[]>,
  currentRows: Row[],
  rowIndex: number,
  cyclic: Set<string>,
  nextId: () => number,
): unknown {
  // 1. Synthetic PK id.
  if (
    table.primaryKey.length === 1 &&
    col.name === table.primaryKey[0] &&
    usesSyntheticId(table)
  ) {
    return nextId();
  }

  // 2. Foreign key: copy a coherent tuple from a parent row.
  const fkHit = fkForColumn(table, col.name);
  if (fkHit) {
    const { fk, idx } = fkHit;
    const refCol = fk.refColumns[idx];

    if (fk.refTable === table.key) {
      // Self-reference: point at an earlier row in this batch, or null.
      const nonNull = !col.nullable;
      if (rowIndex === 0) return nonNull ? currentRows[0]?.[refCol] ?? nextIdPeek(table, nextId) : null;
      if (!nonNull && faker.datatype.boolean({ probability: 0.6 })) return null;
      const parent = faker.helpers.arrayElement(currentRows.slice(0, rowIndex));
      return parent[refCol];
    }

    const parents = generated.get(fk.refTable) ?? [];
    if (parents.length === 0) return col.nullable ? null : undefined;
    return faker.helpers.arrayElement(parents)[refCol];
  }

  // 3. Optional null for plain nullable columns (never the partition key — a
  //    null there may not route to any partition).
  if (
    col.nullable &&
    !isInAnyUnique(table, col.name) &&
    !table.partition?.keyColumns.includes(col.name) &&
    faker.datatype.boolean({ probability: NULL_PROBABILITY })
  ) {
    return null;
  }

  // 4. Generated value.
  const gen = gens.get(col.name);
  return gen ? gen(faker) : null;
}

function nextIdPeek(table: TableInfo, nextId: () => number): unknown {
  // For a non-null self-ref on row 0, reference id 1 (itself).
  return usesSyntheticId(table) ? 1 : null;
}

function isInAnyUnique(table: TableInfo, colName: string): boolean {
  if (table.primaryKey.includes(colName)) return true;
  return table.uniques.some((u) => u.includes(colName));
}

function serializeKey(v: unknown): string {
  if (v === null || v === undefined) return " ";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
