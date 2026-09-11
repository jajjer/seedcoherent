/**
 * Status coherence: keep a row's lifecycle-state column agreeing with the
 * event-timestamp columns it implies.
 *
 * Without this, a `status` column and the timestamps that record reaching each
 * state are drawn independently, so a row can come out `status = 'pending'` with
 * a non-null `shipped_at`/`delivered_at`, or `status = 'cancelled'` with a null
 * `cancelled_at`. Constraint-valid, but nonsensical. This module finds a table's
 * status column (a column whose value domain is a bounded label set — a Postgres/
 * MySQL enum or a `CHECK (col IN (...))`), maps each label onto the date/timestamp
 * column that marks reaching it (`shipped` → `shipped_at`, `cancelled` →
 * `cancelled_at`), and rewrites those markers, per row, so that:
 *   - the marker for the current state (and every earlier state in the lifecycle)
 *     is non-null and dated at/after the row's creation, and
 *   - markers for states not yet reached are null.
 *
 * Lifecycle order is read from the label declaration order — enum labels and
 * `IN (...)` lists are almost always written in the order states occur
 * (`'pending','paid','shipped','delivered'`). "Branch" states that abort the
 * flow (cancelled, refunded, rejected, …) are recognized separately: they don't
 * imply the progress states ran, so when the row sits on a branch state its own
 * marker is set, the other branches' markers are nulled, and the progress markers
 * are left as generated (how far it got before aborting is genuinely unknown).
 *
 * Like temporal and intra-row coherence, it runs as a post-pass over an
 * already-generated row — after the temporal pass, so a marker can be dated
 * relative to the settled creation timestamp. A marker column that is NOT NULL
 * can't be nulled, so it's left as-is; user-pinned (`--column`) and partition-key
 * columns are never touched. Draws use a dedicated Faker so the main and
 * coherence RNG streams — and therefore every other column's seeded output —
 * stay byte-identical.
 */

import type { Faker } from "@faker-js/faker";
import type { ColumnCheck, ColumnInfo, TableInfo } from "./types.js";
import { fromMs, type TemporalWindow } from "./temporal.js";

const norm = (s: string) => s.toLowerCase().replace(/[_\s-]+/g, "");
const toks = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * Labels naming a state that aborts the lifecycle rather than advancing it. A row
 * on one of these didn't necessarily pass through the progress states, so its
 * predecessors' markers are left alone rather than forced non-null.
 */
const BRANCH_LABELS = new Set([
  "cancelled", "canceled", "refunded", "rejected", "failed", "declined",
  "returned", "voided", "abandoned", "denied", "reversed", "chargeback",
  "errored", "error", "disputed", "revoked",
]);

/** Column-name tokens that mark a column as a point-in-time event stamp. */
const MARKER_SUFFIX = new Set(["at", "date", "on", "time", "timestamp", "ts", "datetime"]);

/**
 * Participle → root for a few common state verbs, so `ship_date` associates with
 * the label `shipped` even though the column drops the participle ending. Direct
 * containment (`shipped_at` contains `shipped`) covers the usual `<label>_at`
 * naming; this only fills the gap for the shortened root form.
 */
const LABEL_ROOTS: Record<string, string> = {
  shipped: "ship", delivered: "deliver", cancelled: "cancel", canceled: "cancel",
  refunded: "refund", completed: "complete", approved: "approve", rejected: "reject",
  paid: "pay", resolved: "resolve", closed: "close", published: "publish",
  archived: "archive", activated: "activate", deleted: "delete", returned: "return",
  fulfilled: "fulfill", confirmed: "confirm", verified: "verify", processed: "process",
  received: "receive", accepted: "accept", declined: "decline",
};

interface Marker {
  column: string;
  dateOnly: boolean;
  nullable: boolean;
}

export interface StatusPlan {
  statusColumn: string;
  /** Progress-state labels (lowercased) in lifecycle order. */
  progress: string[];
  /** Branch/abort labels present in the domain (lowercased). */
  branch: Set<string>;
  /** Event-marker column(s) implied by each label (keyed by lowercased label). */
  markers: Map<string, Marker[]>;
}

/** A column is a status column if its value domain is a bounded label set. */
function labelDomain(col: ColumnInfo, check: ColumnCheck | undefined): string[] | null {
  if (col.enumValues && col.enumValues.length >= 2) return col.enumValues;
  const inSet = check?.in;
  if (inSet && inSet.length >= 2 && inSet.every((v) => typeof v === "string")) {
    return inSet as string[];
  }
  return null;
}

/** Does this column's name read like a lifecycle-state column? */
function isStatusName(col: ColumnInfo): boolean {
  const t = toks(col.name);
  return t.some((x) => x === "status" || x === "state" || x === "phase" || x === "stage");
}

/** Is `col` an event-marker for `label`? A date/timestamp column carrying the label stem. */
function markerFor(col: ColumnInfo, label: string): boolean {
  if (col.dataType !== "timestamp" && col.dataType !== "date") return false;
  const n = norm(col.name);
  const lab = norm(label);
  if (lab && n.includes(lab)) return true;
  const root = LABEL_ROOTS[lab];
  if (!root) return false;
  // Only accept the shortened root when the name also ends in an event suffix, so
  // `ship_date` matches but an unrelated `relationship` (contains "ship") does not.
  const t = toks(col.name);
  const suffixed = t.length > 0 && MARKER_SUFFIX.has(t[t.length - 1]);
  return suffixed && t.includes(root);
}

/**
 * Build a table's status plan, or null when nothing coheres. Needs a status
 * column with a bounded label domain and at least one date/timestamp marker that
 * matches one of the labels — otherwise there is nothing to keep in agreement.
 * Each marker column is assigned to the single most-specific (longest) label it
 * matches, so a column is never governed by two conflicting states.
 */
export function planStatus(table: TableInfo, checks: Map<string, ColumnCheck>): StatusPlan | null {
  let statusColumn: string | undefined;
  let labels: string[] | undefined;
  for (const col of table.columns) {
    if (!isStatusName(col)) continue;
    const domain = labelDomain(col, checks.get(col.name));
    if (domain) {
      statusColumn = col.name;
      labels = domain;
      break; // first bounded status column wins
    }
  }
  if (!statusColumn || !labels) return null;

  // Assign each marker column to its longest matching label (most specific).
  const byLabel = [...labels].sort((a, b) => b.length - a.length);
  const markers = new Map<string, Marker[]>();
  const claimed = new Set<string>();
  for (const label of byLabel) {
    for (const col of table.columns) {
      if (col.name === statusColumn || claimed.has(col.name)) continue;
      if (!markerFor(col, label)) continue;
      claimed.add(col.name);
      const key = label.toLowerCase();
      const arr = markers.get(key) ?? [];
      arr.push({ column: col.name, dateOnly: col.dataType === "date", nullable: col.nullable });
      markers.set(key, arr);
    }
  }
  if (markers.size === 0) return null;

  const branch = new Set<string>();
  const progress: string[] = [];
  for (const label of labels) {
    const lc = label.toLowerCase();
    if (BRANCH_LABELS.has(lc)) branch.add(lc);
    else progress.push(lc);
  }
  return { statusColumn, progress, branch, markers };
}

/**
 * Rewrite a row's event-marker columns in place so they agree with its status.
 * `createdMs` is the row's settled creation time (from the temporal pass), used
 * to floor any marker we fill; null when the table has no creation column, in
 * which case the window start is the floor. `frozen` names columns to leave as-is
 * (user overrides, partition keys); `eligible` is true for generator-owned
 * columns (excludes FK-driven ones). Draws use `faker`, so output stays
 * deterministic under a seed.
 */
export function applyStatus(
  plan: StatusPlan,
  row: Record<string, unknown>,
  createdMs: number | null,
  win: TemporalWindow,
  faker: Faker,
  eligible: (colName: string) => boolean,
  frozen: (colName: string) => boolean,
): void {
  const raw = row[plan.statusColumn];
  if (typeof raw !== "string") return;
  const status = raw.toLowerCase();

  const base = createdMs ?? win.sinceMs;
  // Date a marker at/after `lo` and within the window; returns the time chosen so
  // the caller can advance its floor and keep successive markers ordered.
  const setAfter = (m: Marker, lo: number): number => {
    if (!eligible(m.column) || frozen(m.column)) return lo;
    const ms = faker.number.int({ min: lo, max: Math.max(lo, win.untilMs) });
    row[m.column] = fromMs(ms, m.dateOnly);
    return ms;
  };
  // Ensure a marker that should not exist is null (only when the column allows it).
  const clear = (m: Marker) => {
    if (!eligible(m.column) || frozen(m.column) || !m.nullable) return;
    row[m.column] = null;
  };

  const markersFor = (label: string) => plan.markers.get(label) ?? [];
  const idx = plan.progress.indexOf(status);

  if (idx >= 0) {
    // A progress state: everything up to and including it has happened, and its
    // markers run in lifecycle order (shipped_at <= delivered_at). Later progress
    // states and every branch state have not happened, so their markers are null.
    let floor = base;
    plan.progress.forEach((label, i) => {
      if (i <= idx) for (const m of markersFor(label)) floor = setAfter(m, floor);
      else markersFor(label).forEach(clear);
    });
    for (const label of plan.branch) markersFor(label).forEach(clear);
  } else if (plan.branch.has(status)) {
    // A branch state: its own marker is set, sibling branches are cleared, and the
    // progress markers are left as generated (how far it advanced is unknown).
    for (const m of markersFor(status)) setAfter(m, base);
    for (const label of plan.branch) if (label !== status) markersFor(label).forEach(clear);
  }
}
