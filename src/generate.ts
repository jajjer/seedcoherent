/**
 * Builds coherent rows table-by-table in dependency order: FK columns are
 * filled from parent rows that already exist, uniques/PKs are de-duplicated,
 * and self-referential tables reference earlier rows in the same batch.
 */

import { Faker } from "@faker-js/faker";
import {
  inferGenerator,
  partitionKeyGenerator,
  type Generator,
} from "./infer.js";
import { applyCoherence, planCoherence } from "./coherence.js";
import { resolveLocale } from "./locale.js";
import { parseChecks } from "./checks.js";
import {
  resolveDistribution,
  resolveValueSpec,
  type Sampler,
} from "./distribution.js";
import { DEFAULT_BATCH_SIZE } from "./config.js";
import {
  applyTemporal,
  createdColumn,
  planTemporal,
  temporalWindow,
  timestampMs,
} from "./temporal.js";
import { applyStatus, planStatus } from "./status.js";
import type {
  Config,
  ColumnInfo,
  ColumnOverride,
  ForeignKey,
  Schema,
  TableInfo,
} from "./types.js";

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

/**
 * Append mode: generate new rows into a database that already holds data.
 * Rather than building every parent pool from scratch, FK columns can draw from
 * rows already in the target, and synthetic PK counters continue past the
 * existing maximum so new rows don't collide.
 */
export interface AppendContext {
  /** table.key -> existing rows to draw FK parents from (pre-seeds the pool). */
  existing: Map<string, Row[]>;
  /** table.key -> first synthetic id to assign (max existing id + 1). */
  startIds: Map<string, number>;
  /** table.keys to actually generate new rows for; all others only contribute
   *  their existing pool and emit nothing. */
  generate: Set<string>;
  /** table.key -> existing rows of a *grown* table, used to pre-seed uniqueness
   *  so new values (including a non-integer PK) can't collide with ones already
   *  in the target. Bounded like the parent pool, so collisions are detected
   *  only against the sampled rows. */
  existingUnique?: Map<string, Row[]>;
}

const NULL_PROBABILITY = 0.08;
// Attempts to find a fresh value for a unique constraint before giving up. High
// enough that a domain only a little larger than the row count doesn't give up
// prematurely (25 missed a 26-value / 26-row domain's last slot ~37% of the
// time; 200 cuts that below 0.1%), while still bounding a truly exhausted one.
const UNIQUE_RETRIES = 200;

export function rowCount(table: TableInfo, config: Config): number {
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
 * Should this column appear in the INSERT at all? We drop DB-assigned columns,
 * and also drop an unsupported-type column that carries a DB default and hasn't
 * been overridden — leaving it out lets the database supply a valid default we
 * can't synthesize (money, interval, geometry, …), instead of inserting NULL.
 */
function emitsColumn(
  table: TableInfo,
  col: ColumnInfo,
  config: Config,
): boolean {
  if (isDbAssigned(col)) return false;
  if (
    col.dataType === "unsupported" &&
    (col.hasDefault || col.isIdentity) &&
    !isOverridden(table, col.name, config.columns)
  ) {
    return false;
  }
  return true;
}

/** Columns of a type we can't generate for and can't skip. */
export interface UnsupportedColumn {
  /** Owning table's `schema.table` key. */
  table: string;
  column: string;
  /** The raw type name, for the error message. */
  udtName: string;
}

/**
 * Finds NOT NULL columns of an unsupported type that we can neither generate a
 * valid value for nor safely omit: no DB default, no user override, and not
 * served by a foreign key (whose value would come from a parent row). Inserting
 * these would fail, so the CLI reports them up front. Only the tables in
 * `tableKeys` (the ones a run will actually generate) are inspected.
 */
export function requiredUnsupportedColumns(
  schema: Schema,
  config: Config,
  tableKeys: Iterable<string>,
): UnsupportedColumn[] {
  const out: UnsupportedColumn[] = [];
  for (const key of tableKeys) {
    const table = schema.tables.get(key);
    if (!table) continue;
    for (const col of table.columns) {
      if (col.dataType !== "unsupported") continue;
      if (col.nullable || col.hasDefault || col.isIdentity || col.isGenerated)
        continue;
      if (isOverridden(table, col.name, config.columns)) continue;
      if (fkForColumn(table, col.name)) continue;
      out.push({ table: table.key, column: col.name, udtName: col.udtName });
    }
  }
  return out;
}

/** A NOT NULL foreign key whose parent pool is empty when its table generates. */
export interface UnsatisfiableFk {
  /** Owning (child) table's `schema.table` key. */
  table: string;
  /** The child's FK columns. */
  columns: string[];
  /** Referenced parent table's key. */
  refTable: string;
  /** `cycle`: parent generates rows but only later (a NOT NULL FK cycle).
   *  `empty-parent`: parent produces no rows at all (skipped / zero count). */
  reason: "cycle" | "empty-parent";
}

/**
 * Finds NOT NULL cross-table foreign keys that can't be satisfied: when the
 * child table generates, the parent pool is empty — the parent sits later in the
 * cycle-broken order (an unsatisfiable NOT NULL FK cycle), or it produces no rows
 * (skipped, zero count, or not grown in append). Such a column would otherwise be
 * emitted as NULL and rejected at insert time, so callers report it up front.
 * Self-references are excluded — the generator points the first row at itself.
 */
export function unsatisfiableRequiredFks(
  schema: Schema,
  order: TableInfo[],
  config: Config,
  append?: AppendContext,
): UnsatisfiableFk[] {
  const skip = new Set(config.skip ?? []);
  const willGenerate = (table: TableInfo): boolean =>
    append
      ? append.generate.has(table.key)
      : !skip.has(table.name) &&
        !skip.has(table.key) &&
        rowCount(table, config) > 0;
  const producesRows = (table: TableInfo): boolean =>
    willGenerate(table) || (append?.existing.has(table.key) ?? false);

  // Walk the generation order, tracking which parents already hold rows. A
  // required FK to a table not yet available is unsatisfiable.
  const available = new Set<string>();
  if (append) for (const key of append.existing.keys()) available.add(key);

  const out: UnsatisfiableFk[] = [];
  for (const table of order) {
    if (willGenerate(table)) {
      for (const fk of table.foreignKeys) {
        if (fk.refTable === table.key) continue; // self-ref handled in-generator
        if (available.has(fk.refTable)) continue;
        const required = fk.columns.some((cn) => {
          const c = table.columns.find((x) => x.name === cn);
          return c !== undefined && !c.nullable;
        });
        if (!required) continue;
        const parent = schema.tables.get(fk.refTable);
        out.push({
          table: table.key,
          columns: fk.columns,
          refTable: fk.refTable,
          reason: parent && producesRows(parent) ? "cycle" : "empty-parent",
        });
      }
    }
    if (producesRows(table)) available.add(table.key);
  }
  return out;
}

/**
 * Describes why a partitioned table's generated rows might not route to any
 * partition, or null when routing is safe. A `DEFAULT` partition always accepts
 * a row, so a table that has one is never flagged. Otherwise the generator can
 * only confine a single-column RANGE/LIST key with parseable bounds; hash,
 * expression, multi-column, and unparseable-bound keys are best-effort and may
 * produce a value no partition covers (rejected at insert time unless coverage
 * happens to be complete).
 */
export function unroutablePartition(table: TableInfo): string | null {
  const p = table.partition;
  if (!p || p.hasDefault) return null;
  if (p.strategy === "hash") return "hash partitioning";
  if (p.keyColumns.length === 0) return "an expression partition key";
  if (p.keyColumns.length > 1) return "a multi-column partition key";
  if (p.strategy === "range") {
    const bounded = p.ranges?.some((r) => r.from !== null || r.to !== null);
    if (!bounded) return "no parseable RANGE bounds";
  }
  if (p.strategy === "list" && !(p.list && p.list.length > 0)) {
    return "no parseable LIST values";
  }
  return null;
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
  append?: AppendContext,
): IterableIterator<Batch> {
  // The requested --locale (default: US English) drives every generated value.
  const locale = resolveLocale(config.locale);
  const faker = new Faker({ locale: locale.main });
  // A separate faker instance drives the intra-row coherence pass; it keeps
  // en_US in the chain so US postcode-by-state data stays available (absent from
  // plain `en`). Keeping it off the main faker leaves every non-coherence
  // column's seeded output byte-identical.
  const cohFaker = new Faker({ locale: locale.coherence });
  // A third instance drives the status-coherence pass (event-marker timestamps).
  // Its own stream leaves the main and coherence RNG output byte-identical.
  const statusFaker = new Faker({ locale: locale.main });
  if (config.seed !== undefined) {
    faker.seed(config.seed);
    cohFaker.seed(config.seed);
    statusFaker.seed(config.seed);
    // Date generators reference "now" by default; pin it so seeded runs are
    // fully reproducible.
    faker.setDefaultRefDate("2025-01-01T00:00:00.000Z");
  }

  const skip = new Set(config.skip ?? []);
  const generated = new Map<string, Row[]>(); // table.key -> rows (for FK lookups)
  // In append mode, pre-seed the FK pools with rows already in the target so new
  // children can reference existing parents.
  if (append)
    for (const [key, rows] of append.existing) generated.set(key, rows);

  // Fail fast if a NOT NULL FK can't be satisfied (parent generated later in a
  // cycle, or produces no rows) — otherwise the column would be emitted as NULL
  // and rejected at insert time.
  const unsatisfiable = unsatisfiableRequiredFks(schema, order, config, append);
  if (unsatisfiable.length > 0) {
    const lines = unsatisfiable.map(
      (u) =>
        `  ${u.table} (${u.columns.join(", ")}) → ${u.refTable}` +
        (u.reason === "cycle"
          ? " — NOT NULL FK cycle"
          : " — parent has no rows"),
    );
    throw new Error(
      [
        `Can't satisfy ${unsatisfiable.length} NOT NULL foreign key(s); the parent has no rows when the child is generated:`,
        ...lines,
        "",
        "Make the FK column nullable, give the parent rows (don't --skip it / set a non-zero count), or for a true cycle use a DEFERRABLE constraint.",
      ].join("\n"),
    );
  }

  // Temporal coherence: the causal window plus each table's creation column, so
  // a child's creation time can be floored at its parents'.
  const window = temporalWindow(config);
  const createdColOf = new Map<string, string>();
  for (const table of order) {
    const c = createdColumn(table);
    if (c) createdColOf.set(table.key, c);
  }

  for (const table of order) {
    if (skip.has(table.name) || skip.has(table.key)) continue;
    // Append mode only generates the tables the user asked for; every other
    // table just lends its existing pool (seeded above) and emits nothing.
    if (append && !append.generate.has(table.key)) continue;

    const emitCols = table.columns.filter((c) => emitsColumn(table, c, config));
    // Warn when a partitioned table's key can't be confined to a covered
    // partition and there's no DEFAULT — the insert may be rejected if coverage
    // isn't complete. A warning, not an error, since coverage might be complete.
    const unroutable = unroutablePartition(table);
    if (unroutable) {
      process.stderr.write(
        `seedcoherent: ${table.key} is partitioned with ${unroutable} and no ` +
          `DEFAULT partition; generated rows may not route to a partition and ` +
          `the insert could be rejected. Add a DEFAULT partition or pin the key ` +
          `with --column ${table.key}.<key>=value:<covered-value>.\n`,
      );
    }
    // Distill CHECK constraints into per-column bounds the generators honor.
    const checks = parseChecks(table.checks);
    // Pre-resolve a generator per non-FK column.
    const gens = new Map<string, Generator>();
    for (const col of emitCols) {
      if (!fkForColumn(table, col.name)) {
        // A partition-key column must stay inside an existing partition, else the
        // parent-table insert has nowhere to route the row.
        const partGen = table.partition
          ? partitionKeyGenerator(col, table.partition)
          : null;
        // A configured value distribution (non-FK columns only — FK columns take
        // the parent-selection path above) reshapes a categorical column's labels.
        const dist = resolveValueSpec(table, col.name, config.distributions);
        gens.set(
          col.name,
          partGen ??
            inferGenerator(
              table,
              col,
              config.columns,
              checks.get(col.name),
              dist,
            ),
        );
      }
    }
    // Pre-resolve a per-column NULL fraction for the plain-nullable path; columns
    // without a configured rate fall back to the default in valueForColumn.
    const nullRates = new Map<string, number>();
    if (config.nullRates) {
      for (const col of emitCols) {
        const rate = resolveNullRate(table, col.name, config.nullRates);
        if (rate !== undefined) nullRates.set(col.name, rate);
      }
    }
    // Bind a parent-selection sampler per cross-table FK. Topological order means
    // every parent pool is already fully generated, so each sampler can be fixed
    // to its pool now (precomputing any weight tables once). Self-refs stay on the
    // per-row path in valueForColumn — they draw from the batch built so far.
    const fkSamplers = new Map<ForeignKey, Sampler<Row>>();
    for (const fk of table.foreignKeys) {
      if (fk.refTable === table.key) continue;
      const parents = generated.get(fk.refTable) ?? [];
      if (parents.length === 0) continue; // no parents → columns fall back to null/undefined
      const dist = resolveDistribution(table, fk.columns, config.distributions);
      fkSamplers.set(fk, dist.bind(parents));
    }

    // Temporal coherence plan for this table, plus which of its columns are off
    // limits (user-pinned via --column, or a partition key that must route to a
    // real partition).
    const tplan = planTemporal(table);
    // Intra-row coherence plan (names/addresses that should agree). Only columns
    // the generator owns are rewritten — `gens` excludes FK-driven columns.
    const cplan = planCoherence(table);
    // Status coherence plan: a lifecycle-state column and the event-marker
    // timestamps its labels imply (shipped → shipped_at). Reuses the CHECK bounds
    // already parsed above to spot `status IN (...)` domains.
    const splan = planStatus(table, checks);
    const partitionKeys = new Set(table.partition?.keyColumns ?? []);
    const frozen = (colName: string) =>
      partitionKeys.has(colName) ||
      isOverridden(table, colName, config.columns);
    const coherenceEligible = (colName: string) => gens.has(colName);

    const count = rowCount(table, config);
    // Full row history for this table, needed for self-referential FK draws and
    // to seed the `generated` pool other tables draw from.
    const rows: Row[] = [];
    let pending: Row[] = [];
    // Track seen tuples per unique constraint (PK included).
    const uniqueSets = [table.primaryKey, ...table.uniques].filter(
      (u) => u.length > 0,
    );
    const seen = uniqueSets.map(() => new Set<string>());
    // In append mode, pre-seed each unique set with the values already in the
    // target so a new row can't collide with an existing one (covers a UNIQUE
    // non-PK column and a non-integer PK, which startIds doesn't continue).
    const existingUnique = append?.existingUnique?.get(table.key);
    if (existingUnique) {
      for (const r of existingUnique) {
        uniqueSets.forEach((cols, idx) => {
          seen[idx].add(cols.map((c) => serializeKey(r[c])).join("\u0001"));
        });
      }
    }

    // Synthetic ids continue past whatever is already in the target (append),
    // else start at 1.
    let idCounter = append?.startIds.get(table.key) ?? 1;
    for (let i = 0; i < count; i++) {
      let row: Row | null = null;

      for (let attempt = 0; attempt < UNIQUE_RETRIES; attempt++) {
        const candidate: Row = {};
        // Per-row cache of the parent chosen for each cross-table FK. The parent
        // is drawn lazily when the FK's first column is reached (keeping the RNG
        // sequence identical to selecting inline) and reused for the FK's other
        // columns, so a composite FK copies one coherent parent tuple.
        const fkParents = new Map<ForeignKey, Row | null>();
        for (const col of emitCols) {
          candidate[col.name] = valueForColumn(
            table,
            col,
            gens,
            nullRates,
            faker,
            fkSamplers,
            fkParents,
            rows,
            i,
            () => idCounter,
            candidate,
          );
        }
        // Rewrite date/timestamp columns so this row's creation time follows the
        // parents it references and its own activity/expiry columns follow it.
        if (tplan) {
          applyTemporal(
            tplan,
            candidate,
            parentFloor(fkParents, createdColOf),
            window,
            faker,
            frozen,
          );
        }
        // Make a row's names/addresses agree with each other before uniqueness is
        // checked, so a coherent value (e.g. a unique email derived from the name)
        // participates in the collision test.
        if (cplan) {
          applyCoherence(
            cplan,
            candidate,
            cohFaker,
            coherenceEligible,
            frozen,
            locale.usAddress,
          );
        }
        // Make event-marker timestamps agree with the row's status (shipped_at set
        // once shipped, cleared while pending). Runs after temporal so a filled
        // marker can be floored at the settled creation time.
        if (splan) {
          const createdCol = createdColOf.get(table.key);
          const createdMs = createdCol
            ? timestampMs(candidate[createdCol])
            : null;
          applyStatus(
            splan,
            candidate,
            createdMs,
            window,
            statusFaker,
            coherenceEligible,
            frozen,
          );
        }
        // Check every unique constraint.
        const keys = uniqueSets.map((cols) =>
          cols.map((c) => serializeKey(candidate[c])).join("\u0001"),
        );
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
    // A short table means a unique constraint ran out of distinct values before
    // the requested count. Previously this was silent; surface it so the caller
    // knows the row count wasn't met (rather than discovering it downstream).
    if (rows.length < count) {
      process.stderr.write(
        `seedcoherent: ${table.key} produced ${rows.length} of ${count} ` +
          `requested rows — a UNIQUE constraint can't yield more distinct ` +
          `values. Lower this table's count or widen the unique column's domain.\n`,
      );
    }
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
  append?: AppendContext,
): TableData[] {
  const result: TableData[] = [];
  let current: TableData | null = null;
  // One unbounded batch per table keeps this a simple regrouping of streamData.
  for (const batch of streamData(
    schema,
    order,
    cyclic,
    config,
    Infinity,
    append,
  )) {
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
  append?: AppendContext,
): Promise<TableStats[]> {
  const stats: TableStats[] = [];
  let currentTable: TableInfo | null = null;
  let count = 0;

  for (const batch of streamData(
    schema,
    order,
    cyclic,
    config,
    batchSize,
    append,
  )) {
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
export function usesSyntheticId(table: TableInfo): boolean {
  if (table.primaryKey.length !== 1) return false;
  const col = table.columns.find((c) => c.name === table.primaryKey[0]);
  return (
    !!col && (col.isIdentity || col.hasDefault) && col.dataType === "integer"
  );
}

/**
 * Latest creation time among the parents this row references, or null when none
 * of them carry a creation column. Self-referential FKs are excluded (they are
 * resolved inline and never enter `fkParents`).
 */
function parentFloor(
  fkParents: Map<ForeignKey, Row | null>,
  createdColOf: Map<string, string>,
): number | null {
  let floor: number | null = null;
  for (const [fk, parent] of fkParents) {
    if (!parent) continue;
    const col = createdColOf.get(fk.refTable);
    if (!col) continue;
    const ms = timestampMs(parent[col]);
    if (ms !== null) floor = floor === null ? ms : Math.max(floor, ms);
  }
  return floor;
}

/** Has the user pinned this column via a --column / config override? Mirrors inferGenerator's key forms. */
function isOverridden(
  table: TableInfo,
  colName: string,
  overrides: Record<string, ColumnOverride> = {},
): boolean {
  return (
    overrides[`${table.name}.${colName}`] !== undefined ||
    overrides[`${table.key}.${colName}`] !== undefined ||
    overrides[colName] !== undefined
  );
}

/**
 * Resolve a column's configured NULL fraction, honoring keys of the form
 * "table.column", "schema.table.column", or bare "column" — the same precedence
 * the distribution and per-column override lookups use. Undefined when the
 * column has no configured rate (the caller then applies the default).
 */
export function resolveNullRate(
  table: TableInfo,
  colName: string,
  nullRates: Record<string, number> = {},
): number | undefined {
  return (
    nullRates[`${table.name}.${colName}`] ??
    nullRates[`${table.key}.${colName}`] ??
    nullRates[colName]
  );
}

function valueForColumn(
  table: TableInfo,
  col: ColumnInfo,
  gens: Map<string, Generator>,
  nullRates: Map<string, number>,
  faker: Faker,
  fkSamplers: Map<ForeignKey, Sampler<Row>>,
  fkParents: Map<ForeignKey, Row | null>,
  currentRows: Row[],
  rowIndex: number,
  nextId: () => number,
  candidate: Row,
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
      if (rowIndex === 0)
        // The only valid non-null target for the very first row is itself, so
        // reference the referenced column's own value on this row. It's already
        // populated for the usual case (the PK precedes the FK column); fall back
        // to the synthetic-id peek for an integer PK, else null.
        return nonNull
          ? (candidate[refCol] ??
              currentRows[0]?.[refCol] ??
              nextIdPeek(table, nextId))
          : null;
      if (!nonNull && faker.datatype.boolean({ probability: 0.6 })) return null;
      const parent = faker.helpers.arrayElement(currentRows.slice(0, rowIndex));
      return parent[refCol];
    }

    // Cross-table FK: pick this FK's parent once per row (at its first column),
    // then reuse it so every column of a composite FK copies the same tuple.
    let parent = fkParents.get(fk);
    if (parent === undefined && !fkParents.has(fk)) {
      const sample = fkSamplers.get(fk);
      parent = sample ? sample(faker) : null; // no sampler ⇒ empty parent pool
      fkParents.set(fk, parent);
    }
    if (!parent) return col.nullable ? null : undefined;
    return parent[refCol];
  }

  // 3. Optional null for plain nullable columns (never the partition key — a
  //    null there may not route to any partition).
  if (
    col.nullable &&
    !isInAnyUnique(table, col.name) &&
    !table.partition?.keyColumns.includes(col.name) &&
    faker.datatype.boolean({
      probability: nullRates.get(col.name) ?? NULL_PROBABILITY,
    })
  ) {
    return null;
  }

  // 4. Generated value.
  const gen = gens.get(col.name);
  return gen ? gen(faker) : null;
}

function nextIdPeek(table: TableInfo, nextId: () => number): unknown {
  // For a non-null self-ref on row 0, reference the id this row is about to get
  // (itself) — 1 for a fresh run, or the append start id.
  return usesSyntheticId(table) ? nextId() : null;
}

function isInAnyUnique(table: TableInfo, colName: string): boolean {
  if (table.primaryKey.includes(colName)) return true;
  return table.uniques.some((u) => u.includes(colName));
}

function serializeKey(v: unknown): string {
  if (v === null || v === undefined) return "\u0000";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
