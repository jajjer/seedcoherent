/**
 * Foreign-key parent selection. Referential correctness says a child must point
 * at some real parent; the *distribution* says how those choices spread across
 * parents. Uniform (the default) fans children out evenly — unrealistic, since
 * real data is lopsided. `zipf` skews the choice into a power-law so a few
 * parents collect many children and most collect few, which is what "looks
 * real" means for relationships, not just column values.
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
 * Zipf / power-law: parent at rank `k` (1-based) is chosen with probability
 * proportional to `1 / k**skew`. `skew = 1` is the classic harmonic Zipf (a few
 * parents dominate, a long thin tail); larger values concentrate harder. Bind
 * precomputes the cumulative weights once (O(n)); each draw is a single RNG pull
 * plus a binary search (O(log n)).
 */
function zipfDistribution(skew: number): Distribution {
  return {
    bind<T>(items: T[]): Sampler<T> {
      const n = items.length;
      if (n <= 1) return () => items[0];
      // Cumulative weights w_k = 1/k**skew, so a uniform draw in [0, total)
      // lands in a bucket sized by that rank's weight.
      const cumulative = new Array<number>(n);
      let total = 0;
      for (let k = 0; k < n; k++) {
        total += 1 / Math.pow(k + 1, skew);
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
    },
  };
}

/** Build the strategy described by a {@link DistSpec}. */
export function distributionFor(spec: DistSpec): Distribution {
  if (spec === "uniform") return uniform;
  if (spec === "zipf") return zipfDistribution(DEFAULT_SKEW);
  if (spec.kind === "uniform") return uniform;
  return zipfDistribution(spec.skew ?? DEFAULT_SKEW);
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
