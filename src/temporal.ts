/**
 * Temporal coherence: keep generated timestamps causal.
 *
 * Without this, every date/timestamp column is drawn independently, so an
 * order's `created_at` can predate the user it belongs to, and a row's
 * `updated_at` can predate its own `created_at`. This module classifies a
 * table's date/timestamp columns by role and rewrites their values, per row, so
 * that:
 *   - a row's creation timestamp is >= the creation timestamp of every parent it
 *     references by foreign key (children come after their parents), and
 *   - activity/expiry timestamps are >= the row's own creation timestamp.
 * Creation timestamps stay inside the [since, until] window; expiry/deletion
 * timestamps may run past `until`, since those legitimately point at the future.
 *
 * A column the user has pinned with a `--column` override (or a partition-key
 * column, whose value must route to a real partition) is left untouched.
 */

import type { Faker } from "@faker-js/faker";
import type { ColumnInfo, Config, TableInfo } from "./types.js";

type Role = "created" | "activity" | "future";

interface TemporalCol {
  name: string;
  role: Role;
  /** date (a "YYYY-MM-DD" string) vs timestamp (a Date). */
  dateOnly: boolean;
}

/** A table's temporal columns: the creation anchor plus everything keyed off it. */
export interface TemporalPlan {
  created: TemporalCol;
  /** Activity (updated/last-seen) and future (expires/deleted) columns. */
  others: TemporalCol[];
}

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const REF_DATE = "2025-01-01T00:00:00.000Z";

const norm = (s: string) => s.toLowerCase().replace(/[_\s-]+/g, "");
const toks = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Classify a date/timestamp column by temporal role, mirroring infer.ts's date name rules. */
function roleOf(col: ColumnInfo): Role | null {
  if (col.dataType !== "timestamp" && col.dataType !== "date") return null;
  const n = norm(col.name);
  if (["deletedat", "expiresat", "expiredat"].some((f) => n.includes(f))) return "future";
  if (["updatedat", "modifiedat", "lastseen", "lastlogin"].some((f) => n.includes(f))) return "activity";
  if (["firstseen", "createdat", "insertedat", "registeredat"].some((f) => n.includes(f))) return "created";
  if (toks(col.name).includes("created")) return "created";
  return null;
}

/**
 * Build a table's temporal plan, or null when there is nothing coherent to
 * enforce. A plan needs a creation column to anchor everything else against;
 * without one, activity/future columns have no local ordering to respect and
 * there is no birth time for children to reference.
 */
export function planTemporal(table: TableInfo): TemporalPlan | null {
  let created: TemporalCol | undefined;
  const others: TemporalCol[] = [];
  for (const col of table.columns) {
    const role = roleOf(col);
    if (!role) continue;
    const tc: TemporalCol = { name: col.name, role, dateOnly: col.dataType === "date" };
    if (role === "created") {
      if (!created) created = tc; // first creation-like column wins the anchor
    } else {
      others.push(tc);
    }
  }
  return created ? { created, others } : null;
}

/** Name of a table's creation column, for children to read as a lower bound. */
export function createdColumn(table: TableInfo): string | null {
  return planTemporal(table)?.created.name ?? null;
}

export interface TemporalWindow {
  sinceMs: number;
  untilMs: number;
  /** Upper bound for future (expiry/deletion) columns. */
  futureMs: number;
}

function parseDate(s: string, which: "since" | "until"): number {
  const t = Date.parse(s);
  if (Number.isNaN(t)) {
    throw new Error(`Invalid --${which} date "${s}" (expected an ISO date like 2023-01-01).`);
  }
  return t;
}

/** Resolve the coherence window from config, applying defaults and validating order. */
export function temporalWindow(config: Config): TemporalWindow {
  const defaultUntil = config.seed !== undefined ? Date.parse(REF_DATE) : Date.now();
  const untilMs = config.until !== undefined ? parseDate(config.until, "until") : defaultUntil;
  const sinceMs = config.since !== undefined ? parseDate(config.since, "since") : untilMs - 2 * YEAR_MS;
  if (sinceMs > untilMs) {
    throw new Error(`--since (${config.since}) is after --until (${config.until}).`);
  }
  return { sinceMs, untilMs, futureMs: untilMs + YEAR_MS };
}

/** Coerce a stored temporal value to epoch ms, or null if it isn't a usable date. */
export function timestampMs(v: unknown): number | null {
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  if (typeof v === "number") return Number.isNaN(v) ? null : v;
  return null;
}

function fromMs(ms: number, dateOnly: boolean): unknown {
  const d = new Date(ms);
  return dateOnly ? d.toISOString().slice(0, 10) : d;
}

/**
 * Rewrite a row's temporal columns in place so its creation time sits within
 * [max(since, parentFloor), until] and every activity/future column follows it.
 * `parentFloorMs` is the latest creation time among the parents this row
 * references (null when none apply). `frozen` names columns to leave as-is
 * (user overrides, partition keys). Nullable columns that came out null are
 * preserved. Draws use `faker`, so output stays deterministic under a seed.
 */
export function applyTemporal(
  plan: TemporalPlan,
  row: Record<string, unknown>,
  parentFloorMs: number | null,
  win: TemporalWindow,
  faker: Faker,
  frozen: (colName: string) => boolean,
): void {
  const floor = parentFloorMs !== null ? Math.max(win.sinceMs, parentFloorMs) : win.sinceMs;

  let createdMs: number;
  if (frozen(plan.created.name)) {
    // Respect the pinned value; still use it to anchor the others below.
    createdMs = timestampMs(row[plan.created.name]) ?? floor;
  } else {
    const hi = Math.max(floor, win.untilMs);
    createdMs = faker.number.int({ min: floor, max: hi });
    row[plan.created.name] = fromMs(createdMs, plan.created.dateOnly);
  }

  for (const col of plan.others) {
    if (frozen(col.name)) continue;
    if (row[col.name] == null) continue; // keep an intentionally-null nullable column
    const hi = col.role === "future" ? win.futureMs : win.untilMs;
    const v = faker.number.int({ min: createdMs, max: Math.max(createdMs, hi) });
    row[col.name] = fromMs(v, col.dateOnly);
  }
}
