/**
 * Subset + anonymize: pull a referentially-complete slice of a real database
 * and scrub its non-key columns into fake-but-consistent values.
 *
 * Two phases, both reusing the from-scratch machinery:
 *   1. collectSubset — seed N rows from the root tables, then walk foreign keys
 *      *upward* to a fixpoint so every referenced parent row is included. The
 *      resulting slice is self-consistent: no FK points at a missing row.
 *   2. anonymizeAll — replace every value that is NOT part of a key relationship
 *      with output from the same name/type inference used for generation, keyed
 *      by the original value so equal inputs map to equal fakes (internal
 *      duplicates survive) and unique columns stay unique. Key columns (PKs, FK
 *      columns, and any column referenced by an FK) are preserved verbatim, so
 *      the join graph is byte-identical and referential integrity is guaranteed.
 */

import { createHmac } from "node:crypto";
import { Faker } from "@faker-js/faker";
import { parseChecks } from "./checks.js";
import type { Row, TableData } from "./generate.js";
import { inferGenerator, type Generator } from "./infer.js";
import { resolveLocale } from "./locale.js";
import {
  classifyColumn,
  type PiiCategory,
  type PiiSensitivity,
} from "./pii.js";
import type {
  Config,
  Connection,
  ForeignKey,
  Schema,
  TableInfo,
} from "./types.js";

/** Abstracts the SELECT queries so the closure logic is testable off-DB. */
export interface RowFetcher {
  /**
   * Seed rows: up to `limit` from a root table, in a stable order. An optional
   * raw-SQL `where` predicate (operator-trusted, from `--where`) filters which
   * root rows are selected before the ORDER BY … LIMIT. When `sample` is set
   * (from `--sample`), the stable primary-key order is replaced by a random
   * order, so the `limit` rows are a random sample rather than the first N.
   */
  fetchRoots(
    table: TableInfo,
    limit: number,
    where?: string,
    sample?: boolean,
  ): Promise<Row[]>;
  /** Rows whose `columns` tuple matches one of `keys` — for pulling parents. */
  fetchByKeys(
    table: TableInfo,
    columns: string[],
    keys: unknown[][],
  ): Promise<Row[]>;
  /**
   * The largest value of an integer `column` currently in `table`, or `null` if
   * the table is empty. Used by append mode to continue a synthetic PK sequence
   * past the rows already present.
   */
  maxInt(table: TableInfo, column: string): Promise<number | null>;
}

const KEY_CHUNK = 1000;

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const qual = (t: TableInfo) => `${ident(t.schema)}.${ident(t.name)}`;

/** Live-Postgres implementation of RowFetcher. */
export class PgRowFetcher implements RowFetcher {
  constructor(private client: Connection) {}

  async fetchRoots(
    table: TableInfo,
    limit: number,
    where?: string,
    sample?: boolean,
  ): Promise<Row[]> {
    const filter = where ? ` WHERE ${where}` : "";
    const order = sample
      ? " ORDER BY random()"
      : table.primaryKey.length
        ? ` ORDER BY ${table.primaryKey.map(ident).join(", ")}`
        : "";
    const res = await this.client.query(
      `SELECT * FROM ${qual(table)}${filter}${order} LIMIT $1`,
      [limit],
    );
    return res.rows;
  }

  async fetchByKeys(
    table: TableInfo,
    columns: string[],
    keys: unknown[][],
  ): Promise<Row[]> {
    if (keys.length === 0) return [];
    const rows: Row[] = [];
    for (let i = 0; i < keys.length; i += KEY_CHUNK) {
      const chunk = keys.slice(i, i + KEY_CHUNK);
      if (columns.length === 1) {
        // Single-column FK: `col = ANY($1)` is simpler and index-friendly.
        const res = await this.client.query(
          `SELECT * FROM ${qual(table)} WHERE ${ident(columns[0])} = ANY($1)`,
          [chunk.map((k) => k[0])],
        );
        rows.push(...res.rows);
      } else {
        const params: unknown[] = [];
        const tuples = chunk.map((tuple) => {
          const ph = tuple.map((v) => {
            params.push(v);
            return `$${params.length}`;
          });
          return `(${ph.join(", ")})`;
        });
        const colList = columns.map(ident).join(", ");
        const res = await this.client.query(
          `SELECT * FROM ${qual(table)} WHERE (${colList}) IN (${tuples.join(", ")})`,
          params,
        );
        rows.push(...res.rows);
      }
    }
    return rows;
  }

  async maxInt(table: TableInfo, column: string): Promise<number | null> {
    const res = await this.client.query(
      `SELECT MAX(${ident(column)}) AS m FROM ${qual(table)}`,
    );
    return toInt(res.rows[0]?.m);
  }
}

/** Coerce a driver's MAX() result (number, bigint, string, or null) to a number. */
export function toInt(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v); // handles number, bigint, and numeric string alike
  return Number.isFinite(n) ? n : null;
}

/** Resolve a root spec ("users" or "public.users") to a table. */
function resolveTable(schema: Schema, spec: string): TableInfo | undefined {
  if (schema.tables.has(spec)) return schema.tables.get(spec);
  for (const t of schema.tables.values()) if (t.name === spec) return t;
  return undefined;
}

function serialize(v: unknown): string {
  if (v === null || v === undefined) return "\u0000null";
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return "b:" + v.toString("hex");
  if (typeof v === "object") return "j:" + JSON.stringify(v);
  return typeof v + ":" + String(v);
}

/** Stable identity for a fetched row: its PK, or the whole row if it has none. */
function rowId(table: TableInfo, row: Row): string {
  const cols = table.primaryKey.length
    ? table.primaryKey
    : table.columns.map((c) => c.name);
  return cols.map((c) => serialize(row[c])).join("\u0000");
}

/**
 * Seed the root tables, then pull FK parents transitively until no new rows
 * appear. When `children` is true, also traverse downward: for each collected
 * row, pull child rows (in other tables) whose FK columns point at it.
 * Returns rows per table key, deduplicated, ready to anonymize + emit.
 */
export async function collectSubset(
  schema: Schema,
  roots: Record<string, number>,
  fetcher: RowFetcher,
  wheres: Record<string, string> = {},
  sample = false,
  children = false,
): Promise<Map<string, Row[]>> {
  // Reverse FK index: parentTableKey -> [{childTable, fk}] for downward traversal.
  const reverseIndex = new Map<
    string,
    Array<{ childTable: TableInfo; fk: ForeignKey }>
  >();
  if (children) {
    for (const childTable of schema.tables.values()) {
      for (const fk of childTable.foreignKeys) {
        const list = reverseIndex.get(fk.refTable) ?? [];
        list.push({ childTable, fk });
        reverseIndex.set(fk.refTable, list);
      }
    }
  }

  const selected = new Map<string, Map<string, Row>>();
  const pending: Array<{ table: TableInfo; rows: Row[] }> = [];

  const add = (table: TableInfo, rows: Row[]) => {
    let bucket = selected.get(table.key);
    if (!bucket) selected.set(table.key, (bucket = new Map()));
    const fresh: Row[] = [];
    for (const row of rows) {
      const id = rowId(table, row);
      if (!bucket.has(id)) {
        bucket.set(id, row);
        fresh.push(row);
      }
    }
    if (fresh.length) pending.push({ table, rows: fresh });
  };

  for (const [spec, limit] of Object.entries(roots)) {
    const table = resolveTable(schema, spec);
    if (!table) throw new Error(`--subset: unknown table "${spec}"`);
    add(table, await fetcher.fetchRoots(table, limit, wheres[spec], sample));
  }

  // BFS closure: upward (FK parents) and optionally downward (FK children).
  while (pending.length > 0) {
    const { table, rows } = pending.shift()!;

    // Upward: for each newly added row, ensure its FK parents exist.
    for (const fk of table.foreignKeys) {
      const parent = schema.tables.get(fk.refTable);
      if (!parent) continue;
      const needed = new Map<string, unknown[]>();
      for (const row of rows) {
        const tuple = fk.columns.map((c) => row[c]);
        if (tuple.some((v) => v === null || v === undefined)) continue; // nullable FK left unset
        needed.set(tuple.map(serialize).join("\u0000"), tuple);
      }
      if (needed.size === 0) continue;
      add(
        parent,
        await fetcher.fetchByKeys(parent, fk.refColumns, [...needed.values()]),
      );
    }

    // Downward: pull child rows that reference the collected rows (--children).
    if (children) {
      for (const { childTable, fk } of reverseIndex.get(table.key) ?? []) {
        const needed = new Map<string, unknown[]>();
        for (const row of rows) {
          const tuple = fk.refColumns.map((c) => row[c]);
          if (tuple.some((v) => v === null || v === undefined)) continue;
          needed.set(tuple.map(serialize).join("\u0000"), tuple);
        }
        if (needed.size === 0) continue;
        add(
          childTable,
          await fetcher.fetchByKeys(childTable, fk.columns, [
            ...needed.values(),
          ]),
        );
      }
    }
  }

  const out = new Map<string, Row[]>();
  for (const [key, bucket] of selected) out.set(key, [...bucket.values()]);
  return out;
}

/**
 * For each table, the columns whose values must be preserved verbatim so every
 * join survives: its own primary key, its own FK columns, and any column that
 * some other table's FK references.
 */
function protectedColumns(schema: Schema): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const ensure = (key: string) => {
    let s = map.get(key);
    if (!s) map.set(key, (s = new Set()));
    return s;
  };
  for (const table of schema.tables.values()) {
    const self = ensure(table.key);
    for (const c of table.primaryKey) self.add(c);
    for (const fk of table.foreignKeys) {
      for (const c of fk.columns) self.add(c);
      const ref = ensure(fk.refTable);
      for (const c of fk.refColumns) ref.add(c);
    }
  }
  return map;
}

/** A preserved key column whose values read as PII and so leak into the target. */
export interface PrivateKeyColumn {
  /** Qualified `schema.table` key. */
  table: string;
  column: string;
  category: PiiCategory;
}

/**
 * Key columns that `--subset` would copy to the target **verbatim** (PKs, FK
 * columns, and FK-referenced columns are preserved so joins stay valid) but that
 * `classifyColumn` flags as PII — the classic case being an email used as a
 * primary key. Columns the user already opted into scrubbing via
 * `config.anonymize` are excluded, since a forced join group is remapped
 * consistently and no longer leaks. Returned stable-sorted for deterministic
 * output. Callers warn on a non-empty result.
 */
export function privateKeyColumns(
  schema: Schema,
  config: Config,
): PrivateKeyColumn[] {
  const protectedBy = protectedColumns(schema);
  const isForced = columnMatcher(config.anonymize);
  const out: PrivateKeyColumn[] = [];
  for (const table of schema.tables.values()) {
    const keep = protectedBy.get(table.key);
    if (!keep || keep.size === 0) continue;
    for (const col of table.columns) {
      if (!keep.has(col.name)) continue;
      if (isForced(table, col.name)) continue; // opted into scrubbing
      const pii = classifyColumn(table, col);
      if (!pii) continue;
      out.push({ table: table.key, column: col.name, category: pii.category });
    }
  }
  out.sort((a, b) =>
    a.table === b.table
      ? a.column.localeCompare(b.column)
      : a.table.localeCompare(b.table),
  );
  return out;
}

/** Compile "table.column" / "schema.table.column" / bare "column" patterns into a matcher. */
function columnMatcher(
  patterns?: string[],
): (table: TableInfo, col: string) => boolean {
  if (!patterns || patterns.length === 0) return () => false;
  const set = new Set(patterns);
  return (table, col) =>
    set.has(`${table.name}.${col}`) ||
    set.has(`${table.key}.${col}`) ||
    set.has(col);
}

const MEMBER_SEP = "\u0000";
const memberId = (tableKey: string, col: string) =>
  `${tableKey}${MEMBER_SEP}${col}`;
const splitMember = (m: string): [string, string] => {
  const i = m.indexOf(MEMBER_SEP);
  return [m.slice(0, i), m.slice(i + 1)];
};

/**
 * Group key columns that hold the same logical value across a join, using
 * union-find over each FK's (child column ↔ referenced column) pairing. A group
 * with two or more members is a join key: anonymizing it means remapping every
 * column in the group through one shared, consistent value mapping so foreign
 * keys still resolve. Returns each column's group root, the members per root,
 * and the set of columns that are referenced (parent) keys.
 */
function keyGroups(schema: Schema): {
  groupOf: Map<string, string>;
  members: Map<string, string[]>;
  referenced: Set<string>;
} {
  const parent = new Map<string, string>();
  const ensure = (m: string) => {
    if (!parent.has(m)) parent.set(m, m);
  };
  const find = (m: string): string => {
    let root = m;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (parent.get(m) !== root) {
      const next = parent.get(m)!;
      parent.set(m, root);
      m = next;
    }
    return root;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));
  const referenced = new Set<string>();

  for (const table of schema.tables.values()) {
    for (const c of table.primaryKey) ensure(memberId(table.key, c));
    for (const fk of table.foreignKeys) {
      const refTable = schema.tables.get(fk.refTable);
      for (let i = 0; i < fk.columns.length; i++) {
        const child = memberId(table.key, fk.columns[i]);
        ensure(child);
        if (!refTable) continue;
        const ref = memberId(refTable.key, fk.refColumns[i]);
        ensure(ref);
        referenced.add(ref);
        union(child, ref);
      }
    }
  }

  const groupOf = new Map<string, string>();
  const members = new Map<string, string[]>();
  for (const m of parent.keys()) {
    const root = find(m);
    groupOf.set(m, root);
    let list = members.get(root);
    if (!list) members.set(root, (list = []));
    list.push(m);
  }
  return { groupOf, members, referenced };
}

/** Deterministic representative of a join group: a referenced (parent) key if any. */
function representative(members: string[], referenced: Set<string>): string {
  const refs = members.filter((m) => referenced.has(m)).sort();
  return refs[0] ?? [...members].sort()[0];
}

/**
 * Expand the user's `--link` groups into member sets that share one
 * anonymization mapping. Each group's patterns are matched against every column
 * (a bare `email` links every `email` column), overlapping groups are merged,
 * and any group naming a key column is rejected — those belong to `--anonymize`,
 * which remaps whole join groups. Single-column groups are dropped (nothing to
 * share); the rest map each member to its group root.
 */
function linkGroups(
  schema: Schema,
  groups: string[][] | undefined,
  protectedBy: Map<string, Set<string>>,
): { linkGroupOf: Map<string, string>; linkMembers: Map<string, string[]> } {
  const parent = new Map<string, string>();
  const ensure = (m: string) => {
    if (!parent.has(m)) parent.set(m, m);
  };
  const find = (m: string): string => {
    let root = m;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (parent.get(m) !== root) {
      const next = parent.get(m)!;
      parent.set(m, root);
      m = next;
    }
    return root;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));

  for (const patterns of groups ?? []) {
    const match = columnMatcher(patterns);
    const matched: string[] = [];
    for (const table of schema.tables.values()) {
      for (const col of table.columns) {
        if (!match(table, col.name)) continue;
        if (protectedBy.get(table.key)?.has(col.name)) {
          throw new Error(
            `--link can't include key column ${table.name}.${col.name}; ` +
              `use --anonymize to remap join keys consistently.`,
          );
        }
        matched.push(memberId(table.key, col.name));
      }
    }
    if (matched.length === 0) {
      throw new Error(
        `--link group "${patterns.join("=")}" matched no columns.`,
      );
    }
    matched.forEach(ensure);
    for (let i = 1; i < matched.length; i++) union(matched[0], matched[i]);
  }

  const byRoot = new Map<string, string[]>();
  for (const m of parent.keys()) {
    const root = find(m);
    let list = byRoot.get(root);
    if (!list) byRoot.set(root, (list = []));
    list.push(m);
  }
  const linkGroupOf = new Map<string, string>();
  const linkMembers = new Map<string, string[]>();
  for (const [root, ms] of byRoot) {
    if (ms.length < 2) continue; // one column matched — nothing to share
    linkMembers.set(root, ms);
    for (const m of ms) linkGroupOf.set(m, root);
  }
  return { linkGroupOf, linkMembers };
}

/** Anonymization state shared across every column of one forced join group. */
interface GroupState {
  gen: Generator;
  cache: Map<string, unknown>;
  used: Set<string>;
}

/** What `--subset` would do to a column's values on copy. */
export type ColumnAction =
  | "scrub" // replaced with a fake value
  | "keep" // passed through verbatim because `--preserve` opted it out
  | "key"; // passed through verbatim to keep joins valid (PK/FK/referenced)

/**
 * Precomputed, config-dependent state that `columnDecision` reads. Built once by
 * `buildActionContext` and shared by both `anonymizeAll` (to drive scrubbing) and
 * `scanSubset` (to report), so the two can never disagree about a column's fate.
 */
interface ActionContext {
  protectedBy: Map<string, Set<string>>;
  isPreserved: (table: TableInfo, col: string) => boolean;
  isForced: (table: TableInfo, col: string) => boolean;
  groupOf: Map<string, string>;
  members: Map<string, string[]>;
  referenced: Set<string>;
  forcedGroups: Set<string>;
  linkGroupOf: Map<string, string>;
  linkMembers: Map<string, string[]>;
}

function buildActionContext(schema: Schema, config: Config): ActionContext {
  const protectedBy = protectedColumns(schema);
  const isPreserved = columnMatcher(config.preserve);
  const isForced = columnMatcher(config.anonymize);
  const { groupOf, members, referenced } = keyGroups(schema);
  const { linkGroupOf, linkMembers } = linkGroups(
    schema,
    config.link,
    protectedBy,
  );

  // Join groups (size ≥ 2) the user asked to anonymize — naming any member
  // forces the whole group, so both sides of every join move together.
  const forcedGroups = new Set<string>();
  for (const [root, ms] of members) {
    if (ms.length < 2) continue;
    for (const m of ms) {
      const [tk, c] = splitMember(m);
      const t = schema.tables.get(tk);
      if (t && isForced(t, c)) {
        forcedGroups.add(root);
        break;
      }
    }
  }

  return {
    protectedBy,
    isPreserved,
    isForced,
    groupOf,
    members,
    referenced,
    forcedGroups,
    linkGroupOf,
    linkMembers,
  };
}

/** The action to take for one column, plus (for scrubs) which shared state drives it. */
type ColumnDecision =
  | { action: "key" }
  | { action: "keep" }
  | { action: "scrub"; via: "group" | "link"; root: string }
  | { action: "scrub"; via: "local" };

/**
 * Decide a single column's fate. The branch order mirrors `anonymizeAll`'s loop
 * exactly — this is the extracted body of that loop — so `scanSubset` reports the
 * same outcome the copy would produce.
 */
function columnDecision(
  ctx: ActionContext,
  table: TableInfo,
  col: string,
): ColumnDecision {
  const member = memberId(table.key, col);
  const root = ctx.groupOf.get(member);
  const joinKey = root !== undefined && ctx.members.get(root)!.length >= 2;

  if (joinKey) {
    // A join key moves only when its whole group is forced.
    if (ctx.forcedGroups.has(root!))
      return { action: "scrub", via: "group", root: root! };
    return { action: "key" };
  }
  if (ctx.isPreserved(table, col)) return { action: "keep" };
  // Non-key columns scrub by default; protected-but-ungrouped keys only when forced.
  const keep = ctx.protectedBy.get(table.key);
  if (keep?.has(col) && !ctx.isForced(table, col)) return { action: "key" };
  // A --link member shares one mapping across its whole group.
  const linkRoot = ctx.linkGroupOf.get(member);
  if (linkRoot !== undefined)
    return { action: "scrub", via: "link", root: linkRoot };
  return { action: "scrub", via: "local" };
}

/** One row of the `--scan` privacy report: a column, its PII class, and its fate. */
export interface ScanColumn {
  /** Qualified `schema.table` key. */
  table: string;
  column: string;
  /** Postgres base type (udtName) for operator context. */
  type: string;
  category: PiiCategory | null;
  sensitivity: PiiSensitivity | null;
  action: ColumnAction;
}

/**
 * Classify every emitted column of every table and report the action `--subset`
 * would take — without reading a single source row. Pure and DB-free: it needs
 * only the introspected schema and the anonymization config. Rows where PII is
 * copied verbatim (`action !== "scrub"` with a non-null `category`) are the ones
 * a security reviewer should scrutinize. Sorted stably by table then column.
 */
export function scanSubset(schema: Schema, config: Config): ScanColumn[] {
  const ctx = buildActionContext(schema, config);
  const out: ScanColumn[] = [];
  for (const table of schema.tables.values()) {
    for (const col of table.columns) {
      if (col.isGenerated) continue; // never emitted, so never copied
      const pii = classifyColumn(table, col);
      out.push({
        table: table.key,
        column: col.name,
        type: col.udtName,
        category: pii?.category ?? null,
        sensitivity: pii?.sensitivity ?? null,
        action: columnDecision(ctx, table, col.name).action,
      });
    }
  }
  out.sort((a, b) =>
    a.table === b.table
      ? a.column.localeCompare(b.column)
      : a.table.localeCompare(b.table),
  );
  return out;
}

/** Columns a reviewer must scrutinize: PII that is copied to the target unchanged. */
const leaksVerbatim = (r: ScanColumn) =>
  r.category !== null && r.action !== "scrub";

/**
 * Render a `--scan` report as an aligned human-readable table. A `⚠` marks each
 * row where PII would be copied verbatim; a footer summarizes the counts.
 */
export function formatScanReport(rows: ScanColumn[]): string {
  const colName = (r: ScanColumn) => `${r.table}.${r.column}`;
  const pii = (r: ScanColumn) =>
    r.category ? `${r.category} (${r.sensitivity})` : "—";

  const nameW = Math.max(6, ...rows.map((r) => colName(r).length));
  const typeW = Math.max(4, ...rows.map((r) => r.type.length));
  const piiW = Math.max(3, ...rows.map((r) => pii(r).length));

  const out: string[] = [];
  out.push(
    `  ${"".padEnd(1)} ${"COLUMN".padEnd(nameW)}  ${"TYPE".padEnd(typeW)}  ${"PII".padEnd(piiW)}  ACTION`,
  );
  for (const r of rows) {
    const mark = leaksVerbatim(r) ? "⚠" : " ";
    out.push(
      `  ${mark} ${colName(r).padEnd(nameW)}  ${r.type.padEnd(typeW)}  ${pii(r).padEnd(piiW)}  ${r.action}`,
    );
  }

  const piiCount = rows.filter((r) => r.category !== null).length;
  const leakCount = rows.filter(leaksVerbatim).length;
  out.push("");
  out.push(
    `  ${rows.length} columns · ${piiCount} PII · ${leakCount} PII copied verbatim` +
      (leakCount > 0 ? " ⚠" : ""),
  );
  return out.join("\n");
}

/**
 * Replace values with anonymized ones. By default only non-key columns are
 * scrubbed — join keys pass through verbatim so referential integrity holds.
 * `config.anonymize` opts specific join keys into scrubbing (remapped
 * consistently across the whole group), and `config.preserve` opts specific
 * non-key columns out. Same original → same fake within a column/group
 * (consistency), unique columns stay unique, and NULLs are preserved.
 */
export function anonymizeAll(
  schema: Schema,
  order: TableInfo[],
  selected: Map<string, Row[]>,
  config: Config,
): TableData[] {
  const faker = new Faker({ locale: resolveLocale(config.locale).main });
  if (config.seed !== undefined) {
    faker.seed(config.seed);
    faker.setDefaultRefDate("2025-01-01T00:00:00.000Z");
  }
  const hmacFaker = config.secret
    ? new Faker({ locale: resolveLocale(config.locale).main })
    : undefined;

  const ctx = buildActionContext(schema, config);
  const { members, referenced, linkMembers } = ctx;

  // Build shared state lazily, once per forced group, keyed by group root.
  const groupState = new Map<string, GroupState>();
  const stateForGroup = (root: string): GroupState => {
    let st = groupState.get(root);
    if (st) return st;
    const [tk, c] = splitMember(representative(members.get(root)!, referenced));
    const table = schema.tables.get(tk)!;
    const col = table.columns.find((x) => x.name === c)!;
    const gen = inferGenerator(
      table,
      col,
      config.columns,
      parseChecks(table.checks).get(c),
    );
    groupState.set(root, (st = { gen, cache: new Map(), used: new Set() }));
    return st;
  };

  // Shared state for each --link group: one generator (from the alphabetically
  // first member) plus one cache + used-set across every linked column, so the
  // same original scrubs to the same fake everywhere and distinct originals
  // stay distinct (a bijection, so joins on the value survive).
  const linkState = new Map<string, GroupState>();
  const stateForLink = (root: string): GroupState => {
    let st = linkState.get(root);
    if (st) return st;
    const [tk, c] = splitMember([...linkMembers.get(root)!].sort()[0]);
    const table = schema.tables.get(tk)!;
    const col = table.columns.find((x) => x.name === c)!;
    const gen = inferGenerator(
      table,
      col,
      config.columns,
      parseChecks(table.checks).get(c),
    );
    linkState.set(root, (st = { gen, cache: new Map(), used: new Set() }));
    return st;
  };

  const result: TableData[] = [];

  for (const table of order) {
    const rows = selected.get(table.key);
    if (!rows || rows.length === 0) continue;

    const emitCols = table.columns.filter((c) => !c.isGenerated);
    const checks = parseChecks(table.checks);

    // Single-column uniques whose values we must keep distinct after scrubbing.
    const uniqueCols = new Set<string>();
    for (const u of [table.primaryKey, ...table.uniques])
      if (u.length === 1) uniqueCols.add(u[0]);

    // Plan each column: pass through, or anonymize via group or local state.
    const plan = new Map<
      string,
      {
        group?: GroupState;
        gen?: Generator;
        cache?: Map<string, unknown>;
        used?: Set<string>;
      }
    >();
    for (const col of emitCols) {
      // One source of truth for keep-vs-scrub lives in columnDecision, shared
      // with scanSubset so the --scan report can't drift from what runs here.
      const d = columnDecision(ctx, table, col.name);
      if (d.action !== "scrub") continue; // key / preserved → pass through
      if (d.via === "group") {
        plan.set(col.name, { group: stateForGroup(d.root) });
        continue;
      }
      if (d.via === "link") {
        plan.set(col.name, { group: stateForLink(d.root) });
        continue;
      }
      plan.set(col.name, {
        gen: inferGenerator(table, col, config.columns, checks.get(col.name)),
        cache: new Map(),
        used: uniqueCols.has(col.name) ? new Set() : undefined,
      });
    }

    const out: Row[] = rows.map((row) => {
      const r: Row = {};
      for (const col of emitCols) {
        const p = plan.get(col.name);
        if (!p) {
          r[col.name] = row[col.name];
        } else if (p.group) {
          r[col.name] = anonValue(
            faker,
            p.group.gen,
            row[col.name],
            p.group.cache,
            config.secret,
            hmacFaker,
            p.group.used,
          );
        } else {
          r[col.name] = anonValue(
            faker,
            p.gen!,
            row[col.name],
            p.cache!,
            config.secret,
            hmacFaker,
            p.used,
          );
        }
      }
      return r;
    });

    result.push({ table, rows: out, columns: emitCols });
  }

  return result;
}

const UNIQUE_RETRIES = 50;

function anonValue(
  faker: Faker,
  gen: Generator,
  original: unknown,
  cache: Map<string, unknown>,
  secret?: string,
  hmacFaker?: Faker,
  used?: Set<string>,
): unknown {
  if (original === null || original === undefined) return original; // keep the hole
  const key = serialize(original);
  if (cache.has(key)) return cache.get(key);

  let callFaker = faker;
  if (secret !== undefined && hmacFaker !== undefined) {
    // Seed a dedicated Faker from HMAC(secret, original) so the same secret
    // always produces the same fake for the same real value, across runs.
    const digest = createHmac("sha256", secret).update(key).digest();
    hmacFaker.seed(digest.readUInt32BE(0));
    callFaker = hmacFaker;
  }

  let value = gen(callFaker);
  if (used) {
    for (let i = 0; i < UNIQUE_RETRIES && used.has(serialize(value)); i++)
      value = gen(callFaker);
    used.add(serialize(value));
  }
  cache.set(key, value);
  return value;
}
