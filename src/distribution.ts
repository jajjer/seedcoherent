/**
 * Weighted choice, in two roles that share one idea. For **foreign keys** the
 * choices are parent rows: referential correctness says a child must point at
 * some real parent, and the *distribution* says how those choices spread across
 * parents. For **value columns** the choices are a categorical column's labels
 * (an enum, a `CHECK ... IN (...)` set, or a `values:` override). Uniform (the
 * default) spreads evenly — unrealistic, since real data is lopsided. `zipf`
 * skews into a power-law and `weighted` assigns explicit weights, so a few
 * parents (or a few labels) dominate, which is what "looks real" means.
 */

import { Faker } from "@faker-js/faker";
import type { DistSpec, TableInfo } from "./types.js";

/**
 * Draws one parent from a bound pool. Every draw goes through the seeded faker
 * RNG, so output stays byte-identical under `--seed`.
 */
export type Sampler<T> = (f: Faker) => T;

/**
 * A parent-selection strategy. `bind` fixes it to a concrete parent pool,
 * precomputing any lookup tables once so per-row draws stay cheap. Binding is
 * possible because topological order generates every parent table in full before
 * its children, so the pool is known up front.
 */
export interface Distribution {
  bind<T>(items: T[]): Sampler<T>;
}

/** Default Zipf exponent when none is given — 1 is the classic harmonic law. */
const DEFAULT_SKEW = 1;

/**
 * Even spread. Delegates straight to faker's `arrayElement`, so the default FK
 * path consumes the RNG exactly as it did before distributions existed — seeded
 * output is unchanged for anyone not opting into skew.
 */
const uniform: Distribution = {
  bind: <T>(items: T[]): Sampler<T> => (f) => f.helpers.arrayElement(items),
};

/**
 * Draw from `items` by arbitrary relative `weights` (same length, all > 0).
 * Precomputes the cumulative weights once (O(n)); each draw is a single RNG pull
 * plus a binary search (O(log n)). A uniform draw in [0, total) lands in a bucket
 * sized by that item's weight.
 */
function cumulativeSampler<T>(items: T[], weights: number[]): Sampler<T> {
  const n = items.length;
  if (n <= 1) return () => items[0];
  const cumulative = new Array<number>(n);
  let total = 0;
  for (let k = 0; k < n; k++) {
    total += weights[k];
    cumulative[k] = total;
  }
  return (f) => {
    const target = f.number.float({ min: 0, max: total });
    // First index whose cumulative weight exceeds the target.
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] <= target) lo = mid + 1;
      else hi = mid;
    }
    return items[lo];
  };
}

/** Power-law weights: choice at rank `k` (1-based) gets `1 / k**skew`. */
function zipfWeights(n: number, skew: number): number[] {
  return Array.from({ length: n }, (_, k) => 1 / Math.pow(k + 1, skew));
}

/**
 * Zipf / power-law: choice at rank `k` (1-based, in declared order) is chosen
 * with probability proportional to `1 / k**skew`. `skew = 1` is the classic
 * harmonic Zipf (a few dominate, a long thin tail); larger values concentrate
 * harder.
 */
function zipfDistribution(skew: number): Distribution {
  return {
    bind: <T>(items: T[]): Sampler<T> => cumulativeSampler(items, zipfWeights(items.length, skew)),
  };
}

/** Build the strategy described by a {@link DistSpec}. */
export function distributionFor(spec: DistSpec): Distribution {
  if (spec === "uniform") return uniform;
  if (spec === "zipf") return zipfDistribution(DEFAULT_SKEW);
  // `weighted` carries its own value set — meaningless for FK parents (which have
  // no labels), so it degrades to uniform in that role.
  if (spec.kind === "weighted") return uniform;
  if (spec.kind === "uniform") return uniform;
  return zipfDistribution(spec.skew ?? DEFAULT_SKEW);
}

/**
 * A generator that draws from a categorical column's label set (`values`, in
 * declared order) shaped by `spec`. Returns `null` when the spec is uniform, so
 * the caller keeps its existing even-spread generator and seeded output stays
 * byte-identical for anyone not opting into a skew. `weighted` ignores `values`
 * and draws from its own value/weight pairs. Values are returned as-is, so a
 * numeric or string label flows through the ordinary generator path.
 */
export function valueSampler(values: unknown[], spec: DistSpec): Sampler<unknown> | null {
  if (spec === "uniform" || (typeof spec === "object" && spec.kind === "uniform")) return null;
  if (typeof spec === "object" && spec.kind === "weighted") {
    const items = spec.weights.map((w) => w.value);
    return cumulativeSampler(items, spec.weights.map((w) => w.weight));
  }
  if (values.length === 0) return null;
  const skew = spec === "zipf" ? DEFAULT_SKEW : (spec as { skew?: number }).skew ?? DEFAULT_SKEW;
  return cumulativeSampler(values, zipfWeights(values.length, skew));
}

/**
 * Resolve a per-column value distribution (not a foreign key), honoring config
 * keyed by "table.column", "schema.table.column", or bare "column" — the same
 * precedence the generator overrides use. Returns `undefined` when nothing is
 * configured, so the column takes its ordinary generator untouched.
 */
export function resolveValueSpec(
  table: TableInfo,
  colName: string,
  distributions: Record<string, DistSpec> = {},
): DistSpec | undefined {
  return (
    distributions[`${table.name}.${colName}`] ??
    distributions[`${table.key}.${colName}`] ??
    distributions[colName]
  );
}

/**
 * Resolve the parent-selection distribution for a foreign key, honoring config
 * keyed by "table.column", "schema.table.column", or bare "column" — the same
 * precedence the per-column generator overrides use. `colNames` is the FK's
 * child columns; the first one with a configured spec wins (composite FKs pick
 * one parent for the whole tuple, so a single spec governs them). Absent config
 * means uniform, which preserves the exact RNG sequence of the pre-distribution
 * path.
 */
export function resolveDistribution(
  table: TableInfo,
  colNames: string[],
  distributions: Record<string, DistSpec> = {},
): Distribution {
  for (const colName of colNames) {
    const spec =
      distributions[`${table.name}.${colName}`] ??
      distributions[`${table.key}.${colName}`] ??
      distributions[colName];
    if (spec) return distributionFor(spec);
  }
  return uniform;
}
