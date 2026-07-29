/**
 * Append mode: add new rows to a database that already holds data, keeping every
 * foreign key pointing at a real row.
 *
 * Unlike a from-scratch run (which builds every parent pool itself) or a subset
 * (which reads a slice of a *source* to copy into a *target*), append reads and
 * writes the *same* database. The user names the tables to grow via `--rows`;
 * `planAppend` then:
 *   1. reads a sample of the existing rows of every parent table that is NOT
 *      itself being grown, so new children can reference rows already there, and
 *   2. reads the current MAX of each grown table's synthetic integer PK, so the
 *      new rows continue the sequence instead of colliding with `id = 1..N`.
 * The result is an {@link AppendContext} that `streamData` consumes directly.
 */

import { usesSyntheticId, type AppendContext, type Row } from "./generate.js";
import type { RowFetcher } from "./subset.js";
import type { Config, Schema, TableInfo } from "./types.js";

/**
 * How many existing rows of a referenced (not-grown) parent to pull into the FK
 * pool. New children reference a sample of up to this many existing parents;
 * with more parents than this, the tail is not referenced.
 */
export const APPEND_PARENT_LIMIT = 100_000;

/** Resolve a config `rows` key ("users" or "public.users") to a table. */
function resolveTable(schema: Schema, spec: string): TableInfo | undefined {
  if (schema.tables.has(spec)) return schema.tables.get(spec);
  for (const t of schema.tables.values()) if (t.name === spec) return t;
  return undefined;
}

/**
 * The tables append will generate new rows for: those named in `rows` with a
 * positive count. `defaultRows` is intentionally ignored — append only touches
 * tables the user explicitly asks to grow, never the whole schema.
 */
export function appendTargets(schema: Schema, config: Config): Set<string> {
  const targets = new Set<string>();
  for (const [spec, n] of Object.entries(config.rows ?? {})) {
    if (n > 0) {
      const table = resolveTable(schema, spec);
      if (table) targets.add(table.key);
    }
  }
  return targets;
}

/**
 * Builds the {@link AppendContext} for a run: pulls existing parent pools and
 * synthetic-PK maxima from the live database via `fetcher`. Pure aside from the
 * fetcher, so it is testable off-DB.
 */
export async function planAppend(
  schema: Schema,
  order: TableInfo[],
  config: Config,
  fetcher: RowFetcher,
  parentLimit: number = APPEND_PARENT_LIMIT,
): Promise<AppendContext> {
  const generate = appendTargets(schema, config);
  const existing = new Map<string, Row[]>();
  const startIds = new Map<string, number>();

  // Referenced parents that we are NOT growing supply their rows from the DB.
  const parentKeys = new Set<string>();
  for (const key of generate) {
    const table = schema.tables.get(key);
    if (!table) continue;
    for (const fk of table.foreignKeys) {
      if (fk.refTable !== key && !generate.has(fk.refTable)) parentKeys.add(fk.refTable);
    }
  }
  for (const key of parentKeys) {
    const parent = schema.tables.get(key);
    if (parent) existing.set(key, await fetcher.fetchRoots(parent, parentLimit));
  }

  // Grown tables with a synthetic id continue past the current maximum.
  for (const key of generate) {
    const table = schema.tables.get(key);
    if (table && usesSyntheticId(table)) {
      const max = await fetcher.maxInt(table, table.primaryKey[0]);
      if (max !== null) startIds.set(key, max + 1);
    }
  }

  return { existing, startIds, generate };
}
