/**
 * Dry-run planning: report what a from-scratch generate run *would* write —
 * the table order, per-table row counts, and a few sample rows — without
 * touching the target database.
 */

import { buildData, rowCount, type AppendContext, type Row, type TableData } from "./generate.js";
import type { Config, Schema, TableInfo } from "./types.js";

export interface TablePlan {
  key: string;
  /** Planned row count (respecting --rows / --default-rows / --skip). */
  rows: number;
  cyclic: boolean;
  skipped: boolean;
  /** Up to `sampleSize` example rows, generated with the same seed. */
  sample: Row[];
}

export interface Plan {
  tables: TablePlan[];
  totalRows: number;
}

/**
 * Builds the plan a from-scratch run would follow. Planned counts come straight
 * from the config; the sample rows are generated with counts capped to
 * `sampleSize` so the preview is cheap even for a million-row plan (the sample
 * is illustrative, not the exact rows a full run emits).
 */
export function buildPlan(
  schema: Schema,
  order: TableInfo[],
  cyclic: Set<string>,
  config: Config,
  sampleSize = 3,
): Plan {
  const skip = new Set(config.skip ?? []);
  const isSkipped = (t: TableInfo) => skip.has(t.name) || skip.has(t.key);

  // Cap every table to at most `sampleSize` rows so previewing a large plan
  // stays fast; parents are capped too, which keeps FK references valid.
  const capped: Config = {
    ...config,
    defaultRows: Math.min(config.defaultRows ?? 10, sampleSize),
    rows: Object.fromEntries(
      Object.entries(config.rows ?? {}).map(([k, v]) => [k, Math.min(v, sampleSize)]),
    ),
  };
  const sampled = new Map<string, Row[]>();
  for (const d of buildData(schema, order, cyclic, capped)) {
    sampled.set(d.table.key, d.rows.slice(0, sampleSize));
  }

  const tables: TablePlan[] = order.map((t) => ({
    key: t.key,
    rows: isSkipped(t) ? 0 : rowCount(t, config),
    cyclic: cyclic.has(t.key),
    skipped: isSkipped(t),
    sample: sampled.get(t.key) ?? [],
  }));

  const totalRows = tables.reduce((n, t) => n + t.rows, 0);
  return { tables, totalRows };
}

/**
 * Builds the plan an append run would follow: only the tables being grown appear
 * (others just lend existing rows), and the sample rows are generated with the
 * real append context so FK columns show values drawn from the existing parents.
 */
export function buildAppendPlan(
  schema: Schema,
  order: TableInfo[],
  cyclic: Set<string>,
  config: Config,
  append: AppendContext,
  sampleSize = 3,
): Plan {
  const capped: Config = {
    ...config,
    rows: Object.fromEntries(
      Object.entries(config.rows ?? {}).map(([k, v]) => [k, Math.min(v, sampleSize)]),
    ),
  };
  const sampled = new Map<string, Row[]>();
  for (const d of buildData(schema, order, cyclic, capped, append)) {
    sampled.set(d.table.key, d.rows.slice(0, sampleSize));
  }

  const tables: TablePlan[] = order
    .filter((t) => append.generate.has(t.key))
    .map((t) => ({
      key: t.key,
      rows: rowCount(t, config),
      cyclic: cyclic.has(t.key),
      skipped: false,
      sample: sampled.get(t.key) ?? [],
    }));
  const totalRows = tables.reduce((n, t) => n + t.rows, 0);
  return { tables, totalRows };
}

/**
 * Builds the plan a subset run would follow from its already-collected,
 * anonymized slice. Unlike the from-scratch plan, the counts here are exact —
 * the source rows have really been read and closed over their FK parents — and
 * the sample rows are the actual anonymized values that would land in the
 * target, so the preview shows exactly what the scrub produces.
 */
export function buildSubsetPlan(
  data: TableData[],
  cyclic: Set<string>,
  sampleSize = 3,
): Plan {
  const tables: TablePlan[] = data.map((d) => ({
    key: d.table.key,
    rows: d.rows.length,
    cyclic: cyclic.has(d.table.key),
    skipped: false,
    sample: d.rows.slice(0, sampleSize),
  }));
  const totalRows = tables.reduce((n, t) => n + t.rows, 0);
  return { tables, totalRows };
}

/** Render a plan as the human-readable dry-run report. */
export function formatPlan(plan: Plan, opts: { subset?: boolean; append?: boolean } = {}): string {
  const header = opts.subset
    ? "Subset plan (dry run — source read, nothing written):"
    : opts.append
      ? "Append plan (dry run — existing rows read, nothing written):"
      : "Plan (dry run — nothing was written):";
  const out: string[] = [header, ""];

  const width = plan.tables.reduce((w, t) => Math.max(w, t.key.length), 5);
  out.push(`  ${"#".padStart(3)}  ${"table".padEnd(width)}  ${"rows".padStart(9)}`);
  plan.tables.forEach((t, i) => {
    const marks = [t.cyclic ? "cyclic" : "", t.skipped ? "skipped" : ""].filter(Boolean).join(", ");
    const suffix = marks ? `  (${marks})` : "";
    out.push(
      `  ${String(i + 1).padStart(3)}  ${t.key.padEnd(width)}  ${String(t.rows).padStart(9)}${suffix}`,
    );
  });
  out.push(`  ${" ".repeat(3)}  ${"".padEnd(width)}  ${"─".repeat(9)}`);
  const filled = plan.tables.filter((t) => t.rows > 0).length;
  out.push(
    `  ${" ".repeat(3)}  ${`${filled} tables`.padEnd(width)}  ${String(plan.totalRows).padStart(9)}`,
  );

  const withSamples = plan.tables.filter((t) => t.sample.length > 0);
  if (withSamples.length > 0) {
    out.push("", "Sample rows:");
    for (const t of withSamples) {
      out.push("", `  ${t.key}`);
      for (const row of t.sample) out.push(`    ${formatRow(row)}`);
    }
  }
  return out.join("\n");
}

/** Compact one-line rendering of a sample row (values clipped so wide rows fit). */
function formatRow(row: Row): string {
  const parts = Object.entries(row).map(([k, v]) => `${k}: ${formatValue(v)}`);
  return `{ ${parts.join(", ")} }`;
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (v instanceof Date) return v.toISOString();
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  const clipped = s.length > 40 ? `${s.slice(0, 37)}…` : s;
  return typeof v === "string" ? `'${clipped}'` : clipped;
}
