/**
 * Profiling: learn the *shape* of an existing, populated database and turn it
 * into the same generation knobs a user would otherwise tune by hand.
 *
 * Every recent feature makes synthetic data look real only if you spell out each
 * knob — `--distribution status=weighted:...`, `--null-rate ...=0.7`,
 * `--since`/`--until`. Profiling closes that loop: it samples the live data and
 * derives a {@link Config} fragment that reproduces the observed proportions —
 *   - **null rates** — the fraction of each nullable column that is actually NULL,
 *   - **categorical weights** — a low-cardinality column's real value spread,
 *     emitted as a `weighted` distribution,
 *   - **FK fan-out** — how lopsidedly children point at parents, emitted as a
 *     `zipf` distribution when the observed spread follows a power law,
 *   - **temporal window** — the real min/max of creation timestamps → since/until.
 *
 * The derived fragment is *purely additive*: it plugs into the existing config
 * shape, so generation itself needs no changes. Everything here reads (SELECT/
 * aggregate) only — it never writes to the profiled database.
 */

import { createdColumn, timestampMs } from "./temporal.js";
import type { Config, Connection, DistSpec, Schema, TableInfo } from "./types.js";

/**
 * The aggregate queries profiling needs, abstracted so the analysis is testable
 * off-DB. All reads are aggregates; identifier quoting is the only per-dialect
 * difference, so one {@link SqlProfiler} serves every engine.
 */
export interface Profiler {
  /** Total rows and non-NULL count for one column. */
  counts(table: TableInfo, column: string): Promise<{ total: number; nonNull: number }>;
  /**
   * The most common non-NULL values of a column with their row counts, most
   * frequent first, capped at `limit`. Fetching one more than the cardinality cap
   * lets the caller tell "complete, low-cardinality" from "too many to be a
   * category".
   */
  topValues(table: TableInfo, column: string, limit: number): Promise<Array<{ value: unknown; count: number }>>;
  /**
   * Children-per-parent counts for a (possibly composite) foreign-key column set,
   * largest first, capped at `limit`. The head of this rank-frequency curve is
   * what determines the Zipf exponent.
   */
  fanout(table: TableInfo, columns: string[], limit: number): Promise<number[]>;
  /** Min and max of a column, raw driver values (used for the temporal window). */
  range(table: TableInfo, column: string): Promise<{ min: unknown; max: unknown }>;
}

/** Cardinality cap: a column with more distinct values than this is not treated as categorical. */
const MAX_CATEGORIES = 20;
/** Top-K parents sampled to fit the FK fan-out skew. */
const FANOUT_SAMPLE = 200;
/** Fewer than this many referenced parents is too little signal to claim a power law. */
const MIN_FANOUT_POINTS = 5;
/** Skew below this rounds to "effectively uniform", so we leave the FK unshaped. */
const MIN_SKEW = 0.2;
/** Cap the fitted skew — beyond this the difference is imperceptible and the fit noisy. */
const MAX_SKEW = 3;
/** A power-law fit weaker than this R² is not clean enough to encode as zipf. */
const MIN_FIT_R2 = 0.5;

export interface ProfileOptions {
  maxCategories?: number;
  fanoutSample?: number;
}

export interface ProfileSummary {
  /** Columns that received a derived null rate. */
  nullRates: number;
  /** Columns that received a derived `weighted` distribution. */
  weighted: number;
  /** Foreign keys that received a derived `zipf` distribution. */
  zipf: number;
  /** Derived temporal window, if any creation timestamps were found. */
  window?: { since: string; until: string };
}

export interface ProfileResult {
  /** A Config fragment carrying only the derived knobs. */
  config: Config;
  summary: ProfileSummary;
}

/**
 * SQL implementation of {@link Profiler}. The queries are ANSI-standard; the only
 * per-dialect input is how identifiers are quoted (`ident`) and how a table is
 * referenced (`ref` — schema-qualified on Postgres/MySQL, bare on SQLite). No
 * value ever crosses as a parameter, so the same driver-neutral `Connection`
 * surface works for all three engines without placeholder differences.
 */
export class SqlProfiler implements Profiler {
  constructor(
    private conn: Connection,
    private ident: (s: string) => string,
    private ref: (t: TableInfo) => string,
  ) {}

  async counts(table: TableInfo, column: string): Promise<{ total: number; nonNull: number }> {
    const c = this.ident(column);
    const res = await this.conn.query<{ total: unknown; non_null: unknown }>(
      `SELECT COUNT(*) AS total, COUNT(${c}) AS non_null FROM ${this.ref(table)}`,
    );
    const row = res.rows[0];
    return { total: num(row?.total), nonNull: num(row?.non_null) };
  }

  async topValues(
    table: TableInfo,
    column: string,
    limit: number,
  ): Promise<Array<{ value: unknown; count: number }>> {
    const c = this.ident(column);
    const res = await this.conn.query<{ v: unknown; cnt: unknown }>(
      `SELECT ${c} AS v, COUNT(*) AS cnt FROM ${this.ref(table)} WHERE ${c} IS NOT NULL ` +
        `GROUP BY ${c} ORDER BY cnt DESC, ${c} ASC LIMIT ${intLit(limit)}`,
    );
    return res.rows.map((r) => ({ value: r.v, count: num(r.cnt) }));
  }

  async fanout(table: TableInfo, columns: string[], limit: number): Promise<number[]> {
    const cols = columns.map((c) => this.ident(c));
    const notNull = cols.map((c) => `${c} IS NOT NULL`).join(" AND ");
    const grouped = cols.join(", ");
    const res = await this.conn.query<{ cnt: unknown }>(
      `SELECT COUNT(*) AS cnt FROM ${this.ref(table)} WHERE ${notNull} ` +
        `GROUP BY ${grouped} ORDER BY cnt DESC LIMIT ${intLit(limit)}`,
    );
    return res.rows.map((r) => num(r.cnt));
  }

  async range(table: TableInfo, column: string): Promise<{ min: unknown; max: unknown }> {
    const c = this.ident(column);
    const res = await this.conn.query<{ lo: unknown; hi: unknown }>(
      `SELECT MIN(${c}) AS lo, MAX(${c}) AS hi FROM ${this.ref(table)}`,
    );
    const row = res.rows[0];
    return { min: row?.lo ?? null, max: row?.hi ?? null };
  }
}

/** Coerce a driver COUNT (number, bigint, or numeric string) to a finite number, else 0. */
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** A safe non-negative integer literal for inlining into a LIMIT clause. */
function intLit(n: number): string {
  return String(Math.max(0, Math.floor(n)));
}

/** Column categories whose values are discrete enough to be a real "category". */
const CATEGORICAL_TYPES = new Set(["enum", "boolean", "integer", "text"]);

/** All columns served by a foreign key (their value is copied from a parent). */
function fkColumns(table: TableInfo): Set<string> {
  const out = new Set<string>();
  for (const fk of table.foreignKeys) for (const c of fk.columns) out.add(c);
  return out;
}

function inAnyUnique(table: TableInfo, colName: string): boolean {
  if (table.primaryKey.includes(colName)) return true;
  return table.uniques.some((u) => u.includes(colName));
}

function isPartitionKey(table: TableInfo, colName: string): boolean {
  return !!table.partition?.keyColumns.includes(colName);
}

/** Does any of a config map's key forms already cover this column? Respects user intent. */
function alreadySet(
  table: TableInfo,
  colName: string,
  map: Record<string, unknown> | undefined,
): boolean {
  if (!map) return false;
  return (
    map[`${table.name}.${colName}`] !== undefined ||
    map[`${table.key}.${colName}`] !== undefined ||
    map[colName] !== undefined
  );
}

/**
 * Normalize an observed category value to a JSON-clean, type-correct literal so
 * it round-trips through the config and regenerates as the right type. Drivers
 * disagree on booleans (0/1 vs true/false) and wide integers (bigint as string),
 * so pin them to the column's category.
 */
function normalizeCategory(value: unknown, dataType: string): unknown {
  if (dataType === "boolean") return value === true || value === 1 || value === "1" || value === "true";
  if (dataType === "integer") {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (dataType === "enum" || dataType === "text") return String(value);
  return value;
}

/**
 * Fit a Zipf exponent to observed children-per-parent counts (sorted largest
 * first) by least-squares on the log rank / log count curve — a power law is a
 * straight line there, with slope `-skew`. Returns the skew, or `null` when the
 * data is too flat, too short, or too poor a fit to honestly call a power law
 * (so the FK is left uniform). Pure, so it's unit-testable without a database.
 */
export function fitZipfSkew(counts: number[]): number | null {
  const c = counts.filter((n) => n > 0);
  const n = c.length;
  if (n < MIN_FANOUT_POINTS) return null;

  const xs = c.map((_, i) => Math.log(i + 1)); // log rank (1-based)
  const ys = c.map((v) => Math.log(v)); // log count
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const xbar = mean(xs);
  const ybar = mean(ys);

  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - xbar;
    const dy = ys[i] - ybar;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null; // flat counts → uniform

  const slope = sxy / sxx;
  const skew = -slope;
  if (skew < MIN_SKEW) return null;

  const r2 = (sxy * sxy) / (sxx * syy);
  if (r2 < MIN_FIT_R2) return null; // not a clean power law — don't over-claim

  const rounded = Math.round(Math.min(skew, MAX_SKEW) * 10) / 10;
  return rounded < MIN_SKEW ? null : rounded;
}

/**
 * Sample a populated database and derive a {@link Config} fragment reproducing
 * its shape. Only columns the caller hasn't already configured are examined, and
 * only tables that currently hold data. Reads only — nothing is written.
 */
export async function buildProfile(
  schema: Schema,
  order: TableInfo[],
  config: Config,
  profiler: Profiler,
  opts: ProfileOptions = {},
): Promise<ProfileResult> {
  const maxCategories = opts.maxCategories ?? MAX_CATEGORIES;
  const fanoutSample = opts.fanoutSample ?? FANOUT_SAMPLE;
  const skip = new Set(config.skip ?? []);

  const distributions: Record<string, DistSpec> = {};
  const nullRates: Record<string, number> = {};
  const summary: ProfileSummary = { nullRates: 0, weighted: 0, zipf: 0 };

  // Global creation-time window, accumulated across every table's creation column.
  let windowMin: number | null = null;
  let windowMax: number | null = null;

  for (const table of order) {
    if (skip.has(table.name) || skip.has(table.key)) continue;

    // One count query up front tells us whether the table has data at all; an
    // empty table teaches us nothing, so skip its per-column queries entirely.
    const firstCol = table.columns[0];
    if (!firstCol) continue;
    const tableCount = (await profiler.counts(table, firstCol.name)).total;
    if (tableCount === 0) continue;

    const fkCols = fkColumns(table);

    for (const col of table.columns) {
      if (col.isGenerated) continue;

      // Null rate: only where a NULL is actually valid and generation would draw
      // one — the same exclusions --null-rate itself honors. FK columns take their
      // value from a parent, never a synthesized NULL.
      const nullRateEligible =
        col.nullable &&
        !inAnyUnique(table, col.name) &&
        !isPartitionKey(table, col.name) &&
        !fkCols.has(col.name);
      if (nullRateEligible && !alreadySet(table, col.name, config.nullRates)) {
        const { total, nonNull } = await profiler.counts(table, col.name);
        if (total > 0) {
          const rate = Math.round((1 - nonNull / total) * 1000) / 1000;
          nullRates[`${table.key}.${col.name}`] = rate;
          summary.nullRates++;
        }
      }

      // Categorical weights: a low-cardinality, non-key value column. FK columns,
      // keys, and partition keys are shaped elsewhere or not at all.
      const categoricalEligible =
        CATEGORICAL_TYPES.has(col.dataType) &&
        !fkCols.has(col.name) &&
        !inAnyUnique(table, col.name) &&
        !isPartitionKey(table, col.name);
      if (
        categoricalEligible &&
        !alreadySet(table, col.name, config.distributions) &&
        !alreadySet(table, col.name, config.columns)
      ) {
        const top = await profiler.topValues(table, col.name, maxCategories + 1);
        // More distinct values than the cap → not a category (an id, a name, …).
        // A single value carries no spread worth weighting.
        if (top.length >= 2 && top.length <= maxCategories) {
          distributions[`${table.key}.${col.name}`] = {
            kind: "weighted",
            weights: top.map((t) => ({
              value: normalizeCategory(t.value, col.dataType),
              weight: t.count,
            })),
          };
          summary.weighted++;
        }
      }
    }

    // FK fan-out: how children spread across parents. Keyed on the FK's first
    // column, matching how resolveDistribution looks a foreign key up.
    for (const fk of table.foreignKeys) {
      if (fk.refTable === table.key) continue; // self-refs aren't fanned this way
      const keyCol = fk.columns[0];
      if (alreadySet(table, keyCol, config.distributions)) continue;
      const counts = await profiler.fanout(table, fk.columns, fanoutSample);
      const skew = fitZipfSkew(counts);
      if (skew !== null) {
        distributions[`${table.key}.${keyCol}`] = { kind: "zipf", skew };
        summary.zipf++;
      }
    }

    // Temporal window: fold this table's creation column into the global min/max.
    const created = createdColumn(table);
    if (created) {
      const { min, max } = await profiler.range(table, created);
      const lo = timestampMs(min);
      const hi = timestampMs(max);
      if (lo !== null) windowMin = windowMin === null ? lo : Math.min(windowMin, lo);
      if (hi !== null) windowMax = windowMax === null ? hi : Math.max(windowMax, hi);
    }
  }

  const result: Config = {};
  if (Object.keys(distributions).length) result.distributions = distributions;
  if (Object.keys(nullRates).length) result.nullRates = nullRates;
  if (windowMin !== null && windowMax !== null && windowMin < windowMax) {
    const since = new Date(windowMin).toISOString();
    const until = new Date(windowMax).toISOString();
    result.since = since;
    result.until = until;
    summary.window = { since, until };
  }

  return { config: result, summary };
}

/**
 * Layer a derived profile *beneath* the user's explicit config: any knob the user
 * set (config file or CLI flag) wins, and profiling only fills the gaps. Mutates
 * and returns `config`. `since`/`until` fill only when the user set neither, so a
 * user-supplied window is never half-overwritten.
 */
export function mergeProfile(config: Config, profiled: Config): Config {
  if (profiled.distributions) {
    config.distributions = { ...profiled.distributions, ...config.distributions };
  }
  if (profiled.nullRates) {
    config.nullRates = { ...profiled.nullRates, ...config.nullRates };
  }
  if (config.since === undefined && config.until === undefined) {
    config.since = profiled.since;
    config.until = profiled.until;
  }
  return config;
}

/** A one-line-per-fact human summary of what profiling derived, for stderr. */
export function formatProfileSummary(summary: ProfileSummary): string {
  const lines = [
    `  null rates:      ${summary.nullRates} column(s)`,
    `  weighted values: ${summary.weighted} column(s)`,
    `  FK fan-out:      ${summary.zipf} foreign key(s)`,
  ];
  if (summary.window) {
    lines.push(`  time window:     ${summary.window.since.slice(0, 10)} … ${summary.window.until.slice(0, 10)}`);
  }
  return ["Profiled existing data:", ...lines].join("\n");
}
