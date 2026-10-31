/**
 * Child cardinality: bound how many child rows each referenced parent collects.
 *
 * Where `--distribution` shapes *how lopsided* a fan-out is (each child still
 * independently samples a parent), cardinality inverts the model — it assigns
 * parents to children so every parent lands in a `[min, max]` count. That makes
 * the child table's row count a *derived* quantity: the sum of the per-parent
 * draws, which overrides any `--rows` for that table.
 *
 * Both the real generation path (which needs the parent→child assignment) and
 * the dry-run plan (which needs only the derived total) draw the per-parent
 * counts through {@link perParentCounts} with an identically seeded RNG, so the
 * plan's count matches what a seeded run produces.
 */

import { Faker, en } from "@faker-js/faker";
import type { Row } from "./generate.js";
import type { CardSpec, Config, ForeignKey, TableInfo } from "./types.js";

/** The cardinality-governed FK of a table, with its resolved spec. */
export interface CardBinding {
  fk: ForeignKey;
  spec: CardSpec;
}

/**
 * Look up a cardinality spec for one of a table's columns, honoring the same
 * "table.column" / "schema.table.column" / bare "column" precedence the
 * distribution and null-rate maps use.
 */
function specForColumn(
  table: TableInfo,
  colName: string,
  cardinality: Record<string, CardSpec>,
): CardSpec | undefined {
  return (
    cardinality[`${table.name}.${colName}`] ??
    cardinality[`${table.key}.${colName}`] ??
    cardinality[colName]
  );
}

/**
 * Resolve the single cardinality binding governing a table's children, or
 * `null` when none is configured. Enforces the invariants up front:
 *   - at most one FK per table may carry a spec (two would each demand a
 *     different derived row count);
 *   - the FK may not be self-referential (tree shapes need different logic —
 *     use `--distribution` to skew a self-reference instead);
 *   - the FK may not also carry a `distributions` entry (both decide parent
 *     selection).
 */
export function resolveCardinality(
  table: TableInfo,
  config: Config,
): CardBinding | null {
  const cardinality = config.cardinality;
  if (!cardinality || Object.keys(cardinality).length === 0) return null;

  let found: CardBinding | null = null;
  for (const fk of table.foreignKeys) {
    let spec: CardSpec | undefined;
    for (const col of fk.columns) {
      spec = specForColumn(table, col, cardinality);
      if (spec) break;
    }
    if (!spec) continue;
    if (found)
      throw new Error(
        `Multiple --cardinality specs on "${table.key}" (at most one foreign key per table may be bounded; it already drives the row count)`,
      );
    if (fk.refTable === table.key)
      throw new Error(
        `--cardinality cannot bound the self-referential foreign key on "${table.key}" (use --distribution to skew a self-reference)`,
      );
    if (
      config.distributions &&
      hasDistribution(table, fk, config.distributions)
    )
      throw new Error(
        `"${table.key}.${fk.columns[0]}" has both --cardinality and --distribution; they both decide parent selection — pick one`,
      );
    found = { fk, spec };
  }
  return found;
}

/** True if any of the FK's columns carries a distribution entry. */
function hasDistribution(
  table: TableInfo,
  fk: ForeignKey,
  distributions: Record<string, unknown>,
): boolean {
  return fk.columns.some(
    (col) =>
      distributions[`${table.name}.${col}`] !== undefined ||
      distributions[`${table.key}.${col}`] !== undefined ||
      distributions[col] !== undefined,
  );
}

/**
 * Draw the child count for each of `parentCount` parents. An exact spec
 * (`min === max`) fills deterministically and consumes no RNG, so an exact
 * fan-out is reproducible even without `--seed`; a range draws uniformly in
 * `[min, max]` from `faker`.
 */
export function perParentCounts(
  parentCount: number,
  spec: CardSpec,
  faker: Faker,
): number[] {
  if (spec.min === spec.max) return new Array(parentCount).fill(spec.min);
  const counts = new Array<number>(parentCount);
  for (let i = 0; i < parentCount; i++) {
    counts[i] = faker.number.int({ min: spec.min, max: spec.max });
  }
  return counts;
}

/**
 * Build the parent-per-child assignment for a cardinality FK: expand each parent
 * row by its drawn count, then shuffle so children are interleaved rather than
 * grouped by parent. The returned array's length is the table's derived row
 * count; child row `i` references `assignment[i]`.
 */
export function buildAssignment(
  parents: Row[],
  spec: CardSpec,
  faker: Faker,
): Row[] {
  const counts = perParentCounts(parents.length, spec, faker);
  const assignment: Row[] = [];
  for (let i = 0; i < parents.length; i++) {
    for (let k = 0; k < counts[i]; k++) assignment.push(parents[i]);
  }
  // Shuffle in place so the emitted children aren't ordered parent-by-parent.
  return faker.helpers.shuffle(assignment);
}

/**
 * The derived row count for a cardinality table: the sum of the per-parent
 * draws over `parentCount` parents. Used by the dry-run plan, which knows the
 * parent count but not the parent rows.
 */
export function derivedRowCount(
  table: TableInfo,
  spec: CardSpec,
  parentCount: number,
  config: Config,
): number {
  const counts = perParentCounts(
    parentCount,
    spec,
    cardFakerFor(table, config),
  );
  return counts.reduce((n, c) => n + c, 0);
}

/**
 * A per-table RNG for cardinality draws, isolated from the main generation
 * stream so a cardinality run leaves every non-cardinality column's seeded
 * output byte-identical. Seeding from `config.seed` salted by the table key (so
 * two tables don't draw the same sequence) makes the real run and the plan's
 * count agree. With no `--seed`, a range is non-reproducible — consistent with
 * the rest of the tool.
 */
export function cardFakerFor(table: TableInfo, config: Config): Faker {
  const faker = new Faker({ locale: [en] });
  if (config.seed !== undefined) faker.seed(config.seed + hashKey(table.key));
  return faker;
}

/** Small deterministic string hash (djb2), as a salt for per-table seeding. */
function hashKey(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) | 0;
  // Keep it a modest non-negative magnitude so seed + salt stays well-behaved.
  return Math.abs(h) % 1_000_000;
}
