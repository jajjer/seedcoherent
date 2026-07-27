/** Topologically sorts tables so parents are populated before children. */

import type { Schema, TableInfo } from "./types.js";

export interface SortResult {
  order: TableInfo[];
  /** Table keys that participate in a FK cycle (including self-references). */
  cyclic: Set<string>;
}

/**
 * Kahn's algorithm over the FK dependency graph. Self-references and true
 * cycles can't be fully ordered; we drop the offending edges, record the
 * tables as cyclic (the generator handles them with a nullable/deferred pass),
 * and continue so every table still gets an order slot.
 */
export function topoSort(schema: Schema): SortResult {
  const tables = [...schema.tables.values()];
  const cyclic = new Set<string>();

  // Build dependency edges: child -> set of parent table keys (ignoring self-refs).
  const deps = new Map<string, Set<string>>();
  for (const t of tables) {
    const set = new Set<string>();
    for (const fk of t.foreignKeys) {
      if (fk.refTable === t.key) {
        cyclic.add(t.key); // self-reference
        continue;
      }
      if (schema.tables.has(fk.refTable)) set.add(fk.refTable);
    }
    deps.set(t.key, set);
  }

  const order: TableInfo[] = [];
  const placed = new Set<string>();
  const remaining = new Set(tables.map((t) => t.key));

  while (remaining.size > 0) {
    const ready = [...remaining].filter((key) =>
      [...deps.get(key)!].every((dep) => placed.has(dep) || !remaining.has(dep)),
    );

    if (ready.length === 0) {
      // Everything left is tangled in a cycle. Break it: emit the node with the
      // fewest unmet deps and mark all remaining as cyclic.
      const next = [...remaining].sort(
        (a, b) =>
          [...deps.get(a)!].filter((d) => remaining.has(d)).length -
          [...deps.get(b)!].filter((d) => remaining.has(d)).length,
      )[0];
      for (const key of remaining) cyclic.add(key);
      order.push(schema.tables.get(next)!);
      placed.add(next);
      remaining.delete(next);
      continue;
    }

    for (const key of ready) {
      order.push(schema.tables.get(key)!);
      placed.add(key);
      remaining.delete(key);
    }
  }

  return { order, cyclic };
}
