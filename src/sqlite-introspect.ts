/** Reads a live SQLite schema into our internal representation via PRAGMAs + sqlite_master. */

import { rewriteInLists } from "./checks.js";
import type { ColumnInfo, Connection, ForeignKey, Schema, TableInfo } from "./types.js";

/**
 * Map a SQLite declared column type onto the broad category we generate
 * against. SQLite is dynamically typed: a column's declared type is only a hint
 * ("type affinity"), and schemas routinely declare semantic types SQLite itself
 * treats loosely — `DATETIME`, `BOOLEAN`, `JSON`, `UUID`. We honor those first
 * (so a `created_at DATETIME` gets timestamps, not lorem ipsum), then fall back
 * to SQLite's official affinity rules. Categories match the Postgres/MySQL
 * introspectors so the shared inference/generation layer is dialect-agnostic.
 */
export function categorizeSqlite(declaredType: string): string {
  const t = declaredType.toUpperCase();

  // Semantic hints first — more specific than affinity, and common in the wild.
  if (t.includes("BOOL")) return "boolean";
  if (t.includes("DATETIME") || t.includes("TIMESTAMP")) return "timestamp";
  if (t.includes("DATE")) return "date";
  if (t.includes("TIME")) return "time";
  if (t.includes("JSON")) return "json";
  if (t.includes("UUID") || t.includes("GUID")) return "uuid";

  // SQLite type-affinity rules (https://sqlite.org/datatype3.html#affinity).
  if (t.includes("INT")) return "integer";
  if (t.includes("CHAR") || t.includes("CLOB") || t.includes("TEXT")) return "text";
  if (t === "" || t.includes("BLOB")) return "bytea";
  if (t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB")) return "decimal";
  return "decimal"; // NUMERIC affinity — DECIMAL/NUMERIC/etc.
}

/** Pull `(n)` out of `VARCHAR(255)` as a max length, or null. */
function parseLength(declaredType: string): number | null {
  const m = declaredType.match(/\(\s*(\d+)\s*\)/);
  return m ? Number(m[1]) : null;
}

/** Pull `(p, s)` out of `DECIMAL(10,2)` as [precision, scale]. */
function parsePrecision(declaredType: string): [number | null, number | null] {
  const m = declaredType.match(/\(\s*(\d+)\s*,\s*(\d+)\s*\)/);
  return m ? [Number(m[1]), Number(m[2])] : [null, null];
}

/**
 * Rewrite a SQLite CHECK expression into the shape our (Postgres-oriented) check
 * parser understands: bracket/backtick identifiers become double-quoted, and
 * `col IN ('a','b')` — SQLite's idiomatic enum — is rewritten to the
 * `= ANY (ARRAY[...])` form the parser recognizes as a membership set. Numeric
 * ranges and `length()` bounds carry over as-is; anything else simply doesn't
 * match and is left unconstrained, same as any expression we can't parse.
 */
export function normalizeSqliteCheck(expr: string): string {
  const requoted = expr
    .replace(/`((?:[^`]|``)*)`/g, (_, id: string) => `"${id.replace(/``/g, "`")}"`)
    .replace(/\[([^\]]*)\]/g, (_, id: string) => `"${id}"`);
  return rewriteInLists(requoted);
}

/** Index of the `)` matching the `(` at `open`, or -1. */
function matchingParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/**
 * Extract CHECK clauses from a table's `CREATE TABLE` DDL. SQLite exposes no
 * catalog view for checks, so we scan the stored SQL for each `CHECK (...)`
 * (column- and table-level look identical) and capture its balanced expression.
 */
export function extractChecks(ddl: string): string[] {
  const out: string[] = [];
  const re = /\bCHECK\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(ddl)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchingParen(ddl, open);
    if (close === -1) continue;
    out.push(ddl.slice(open + 1, close).trim());
    re.lastIndex = close + 1;
  }
  return out;
}

interface MasterRow {
  name: string;
  sql: string | null;
}
interface ColumnRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
  hidden: number;
}
interface FkRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
}
interface IndexRow {
  seq: number;
  name: string;
  unique: number;
  origin: string;
}
interface IndexColRow {
  seqno: number;
  cid: number;
  name: string | null;
}

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

/**
 * A single-column `INTEGER PRIMARY KEY` is an alias for SQLite's implicit rowid:
 * the database auto-assigns it (like an identity/serial), and the declared type
 * must be exactly `INTEGER` (any other spelling makes an ordinary PK column).
 */
function isRowidAlias(cols: ColumnInfo[], primaryKey: string[]): boolean {
  if (primaryKey.length !== 1) return false;
  const pk = cols.find((c) => c.name === primaryKey[0]);
  return !!pk && pk.udtName.trim().toUpperCase() === "INTEGER";
}

export async function introspectSqlite(client: Connection, schemas: string[]): Promise<Schema> {
  const tables = new Map<string, TableInfo>();

  for (const schema of schemas) {
    const sref = ident(schema);
    const masterRes = await client.query<MasterRow>(
      `SELECT name, sql FROM ${sref}.sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`,
    );

    for (const { name, sql } of masterRes.rows) {
      const key = `${schema}.${name}`;
      const table: TableInfo = {
        schema,
        name,
        key,
        columns: [],
        primaryKey: [],
        uniques: [],
        foreignKeys: [],
        checks: sql ? extractChecks(sql).map((expr) => ({ expr: normalizeSqliteCheck(expr) })) : [],
      };

      // Columns (table_xinfo also surfaces generated + hidden columns).
      const colRes = await client.query<ColumnRow>(`PRAGMA ${sref}.table_xinfo(${ident(name)})`);
      // pk > 0 gives the column's 1-based position within the primary key.
      const pkCols = colRes.rows
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name);

      for (const c of colRes.rows) {
        // hidden: 0 normal, 1 hidden (virtual-table columns we can't insert),
        // 2 VIRTUAL generated, 3 STORED generated.
        if (c.hidden === 1) continue;
        const isGenerated = c.hidden === 2 || c.hidden === 3;
        const [precision, scale] = parsePrecision(c.type);
        table.columns.push({
          name: c.name,
          udtName: c.type,
          dataType: categorizeSqlite(c.type),
          nullable: c.notnull === 0 && c.pk === 0,
          hasDefault: c.dflt_value !== null,
          defaultExpr: c.dflt_value,
          isIdentity: false, // set below for the rowid alias
          isGenerated,
          maxLength: parseLength(c.type),
          enumValues: null, // SQLite has no enums; `CHECK (x IN (...))` covers the idiom
          numericPrecision: precision,
          numericScale: scale,
        });
      }

      table.primaryKey = pkCols;
      if (isRowidAlias(table.columns, pkCols)) {
        const pk = table.columns.find((c) => c.name === pkCols[0])!;
        pk.isIdentity = true;
        pk.hasDefault = true; // the DB assigns it
      }

      // Foreign keys — rows sharing an `id` form one (composite) key, ordered by seq.
      const fkRes = await client.query<FkRow>(`PRAGMA ${sref}.foreign_key_list(${ident(name)})`);
      const byId = new Map<number, FkRow[]>();
      for (const r of fkRes.rows) {
        let list = byId.get(r.id);
        if (!list) byId.set(r.id, (list = []));
        list.push(r);
      }
      for (const list of byId.values()) {
        list.sort((a, b) => a.seq - b.seq);
        const refTable = list[0].table;
        // A null `to` means the FK references the parent's primary key.
        const refColumns = list.every((r) => r.to !== null)
          ? list.map((r) => r.to as string)
          : (tables.get(`${schema}.${refTable}`)?.primaryKey ?? []);
        table.foreignKeys.push({
          columns: list.map((r) => r.from),
          refTable: `${schema}.${refTable}`,
          refColumns,
        });
      }

      // Unique constraints — index_list origin 'u' (UNIQUE) or 'pk' (a WITHOUT
      // ROWID / composite PK backed by an index). We keep 'u'; the PK is tracked
      // separately above.
      const idxRes = await client.query<IndexRow>(`PRAGMA ${sref}.index_list(${ident(name)})`);
      for (const idx of idxRes.rows) {
        if (idx.unique !== 1 || idx.origin !== "u") continue;
        const cols = await client.query<IndexColRow>(`PRAGMA ${sref}.index_info(${ident(idx.name)})`);
        const names = cols.rows.sort((a, b) => a.seqno - b.seqno).map((r) => r.name);
        // Skip expression indexes (a null column name means an indexed expression).
        if (names.some((n) => n === null)) continue;
        table.uniques.push(names as string[]);
      }

      tables.set(key, table);
    }
  }

  // A late pass to resolve FK refColumns that pointed at a parent's primary key
  // before that parent had been read (forward references within a schema).
  for (const table of tables.values()) {
    for (const fk of table.foreignKeys as ForeignKey[]) {
      if (fk.refColumns.length === 0) {
        fk.refColumns = tables.get(fk.refTable)?.primaryKey ?? [];
      }
    }
  }

  return { tables };
}
