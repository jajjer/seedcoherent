/** Reads a live MySQL schema into our internal representation via information_schema. */

import type { ColumnInfo, Connection, ForeignKey, Schema, TableInfo } from "./types.js";

/**
 * MySQL type name -> broad category we generate against. MySQL folds length,
 * signedness, and enum labels into `COLUMN_TYPE` (e.g. "tinyint(1)",
 * "int unsigned", "enum('a','b')"), so both the base `dataType` and the full
 * `columnType` are consulted. Categories match the Postgres introspector so the
 * shared inference/generation layer is dialect-agnostic.
 */
export function categorizeMysql(
  dataType: string,
  columnType: string,
  enumValues: string[] | null,
): string {
  if (enumValues) return "enum";
  switch (dataType.toLowerCase()) {
    case "tinyint":
      // MySQL has no real boolean; BOOLEAN is an alias for tinyint(1).
      return /^tinyint\(1\)/i.test(columnType) ? "boolean" : "integer";
    case "smallint":
    case "mediumint":
    case "int":
    case "integer":
    case "bigint":
    case "bit":
    case "year":
      return "integer";
    case "decimal":
    case "dec":
    case "numeric":
    case "fixed":
    case "float":
    case "double":
    case "real":
      return "decimal";
    case "date":
      return "date";
    case "time":
      return "time";
    case "datetime":
    case "timestamp":
      return "timestamp";
    case "json":
      return "json";
    case "binary":
    case "varbinary":
    case "blob":
    case "tinyblob":
    case "mediumblob":
    case "longblob":
      return "bytea";
    case "char":
    case "varchar":
    case "text":
    case "tinytext":
    case "mediumtext":
    case "longtext":
    case "set":
      return "text";
    default:
      // Spatial (geometry/point/…) and other types we can't emit a valid literal
      // for. Flag them "unsupported" so generation NULLs/skips or errors clearly,
      // instead of inserting lorem text the column rejects.
      return "unsupported";
  }
}

/** Pull the labels out of a MySQL `enum('a','b',...)` / `set('a','b',...)` column type. */
export function parseEnumValues(columnType: string): string[] | null {
  const m = columnType.match(/^(?:enum|set)\((.*)\)$/is);
  if (!m) return null;
  return splitQuotedList(m[1]).map(unquote);
}

/** Split a comma-separated list of single-quoted literals, respecting `''` escapes. */
function splitQuotedList(s: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") {
      if (inQuote && s[i + 1] === "'") i++; // escaped quote
      else inQuote = !inQuote;
    } else if (ch === "," && !inQuote) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

function unquote(s: string): string {
  const m = s.match(/^'((?:[^']|'')*)'$/);
  return m ? m[1].replace(/''/g, "'") : s;
}

/**
 * Rewrite a MySQL CHECK clause into the shape our (Postgres-oriented) check
 * parser understands: backtick identifiers become double-quoted, and charset
 * introducers (`_utf8mb4'x'`) are stripped. This lets common numeric-range and
 * length bounds carry over; MySQL-only forms (`IN (...)`, `REGEXP`) simply don't
 * match and are left unconstrained, same as any expression we can't parse.
 */
export function normalizeMysqlCheck(clause: string): string {
  return clause
    .replace(/`((?:[^`]|``)*)`/g, (_, id: string) => `"${id.replace(/``/g, "`")}"`)
    .replace(/_[A-Za-z0-9]+(?=')/g, "");
}

interface ColumnRow {
  schema: string;
  table_name: string;
  column_name: string;
  ordinal: number;
  data_type: string;
  column_type: string;
  is_nullable: string;
  default_expr: string | null;
  extra: string;
  max_length: number | string | null;
  numeric_precision: number | string | null;
  numeric_scale: number | string | null;
}

const TABLE_SQL = `
  SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS table_name
  FROM information_schema.TABLES
  WHERE TABLE_SCHEMA IN (?) AND TABLE_TYPE = 'BASE TABLE';
`;

const COLUMN_SQL = `
  SELECT
    TABLE_SCHEMA               AS \`schema\`,
    TABLE_NAME                 AS table_name,
    COLUMN_NAME                AS column_name,
    ORDINAL_POSITION           AS ordinal,
    DATA_TYPE                  AS data_type,
    COLUMN_TYPE                AS column_type,
    IS_NULLABLE                AS is_nullable,
    COLUMN_DEFAULT             AS default_expr,
    EXTRA                      AS extra,
    CHARACTER_MAXIMUM_LENGTH   AS max_length,
    NUMERIC_PRECISION          AS numeric_precision,
    NUMERIC_SCALE              AS numeric_scale
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA IN (?)
  ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION;
`;

interface ConstraintRow {
  schema: string;
  table_name: string;
  ctype: string;
  cname: string;
  column_name: string;
  ref_schema: string | null;
  ref_table: string | null;
  ref_column: string | null;
}

const CONSTRAINT_SQL = `
  SELECT
    tc.TABLE_SCHEMA           AS \`schema\`,
    tc.TABLE_NAME             AS table_name,
    tc.CONSTRAINT_TYPE        AS ctype,
    tc.CONSTRAINT_NAME        AS cname,
    kcu.COLUMN_NAME           AS column_name,
    kcu.REFERENCED_TABLE_SCHEMA AS ref_schema,
    kcu.REFERENCED_TABLE_NAME   AS ref_table,
    kcu.REFERENCED_COLUMN_NAME  AS ref_column
  FROM information_schema.TABLE_CONSTRAINTS tc
  JOIN information_schema.KEY_COLUMN_USAGE kcu
    ON kcu.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
   AND kcu.CONSTRAINT_NAME   = tc.CONSTRAINT_NAME
   AND kcu.TABLE_SCHEMA      = tc.TABLE_SCHEMA
   AND kcu.TABLE_NAME        = tc.TABLE_NAME
  WHERE tc.TABLE_SCHEMA IN (?)
    AND tc.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY')
  ORDER BY tc.TABLE_SCHEMA, tc.TABLE_NAME, tc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION;
`;

interface CheckRow {
  schema: string;
  table_name: string;
  check_clause: string;
}

const CHECK_SQL = `
  SELECT
    tc.TABLE_SCHEMA  AS \`schema\`,
    tc.TABLE_NAME    AS table_name,
    cc.CHECK_CLAUSE  AS check_clause
  FROM information_schema.CHECK_CONSTRAINTS cc
  JOIN information_schema.TABLE_CONSTRAINTS tc
    ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA
   AND tc.CONSTRAINT_NAME   = cc.CONSTRAINT_NAME
  WHERE tc.TABLE_SCHEMA IN (?)
    AND tc.CONSTRAINT_TYPE = 'CHECK';
`;

const toNum = (v: number | string | null): number | null =>
  v === null || v === undefined ? null : Number(v);

export async function introspectMysql(client: Connection, schemas: string[]): Promise<Schema> {
  const tableRes = await client.query<{ schema: string; table_name: string }>(TABLE_SQL, [schemas]);
  const baseTables = new Set(tableRes.rows.map((r) => `${r.schema}.${r.table_name}`));

  const colRes = await client.query<ColumnRow>(COLUMN_SQL, [schemas]);
  const tables = new Map<string, TableInfo>();

  for (const row of colRes.rows) {
    const key = `${row.schema}.${row.table_name}`;
    if (!baseTables.has(key)) continue; // skip views
    let table = tables.get(key);
    if (!table) {
      table = {
        schema: row.schema,
        name: row.table_name,
        key,
        columns: [],
        primaryKey: [],
        uniques: [],
        foreignKeys: [],
        checks: [],
      };
      tables.set(key, table);
    }
    const enumValues = parseEnumValues(row.column_type);
    const extra = (row.extra ?? "").toLowerCase();
    const isIdentity = extra.includes("auto_increment");
    const col: ColumnInfo = {
      name: row.column_name,
      udtName: row.data_type,
      dataType: categorizeMysql(row.data_type, row.column_type, enumValues),
      nullable: row.is_nullable === "YES",
      hasDefault: row.default_expr !== null || isIdentity || extra.includes("default_generated"),
      defaultExpr: row.default_expr,
      isIdentity,
      isGenerated: /\b(virtual|stored) generated\b/.test(extra),
      maxLength: toNum(row.max_length),
      enumValues,
      numericPrecision: toNum(row.numeric_precision),
      numericScale: toNum(row.numeric_scale),
    };
    table.columns.push(col);
  }

  const conRes = await client.query<ConstraintRow>(CONSTRAINT_SQL, [schemas]);
  // Group by constraint so multi-column keys keep their column order.
  const byConstraint = new Map<string, ConstraintRow[]>();
  const conOrder: string[] = [];
  for (const row of conRes.rows) {
    if (!baseTables.has(`${row.schema}.${row.table_name}`)) continue;
    const id = `${row.schema}.${row.table_name}.${row.cname}`;
    let list = byConstraint.get(id);
    if (!list) {
      byConstraint.set(id, (list = []));
      conOrder.push(id);
    }
    list.push(row);
  }

  for (const id of conOrder) {
    const rows = byConstraint.get(id)!;
    const first = rows[0];
    const table = tables.get(`${first.schema}.${first.table_name}`);
    if (!table) continue;
    const cols = rows.map((r) => r.column_name);
    if (first.ctype === "PRIMARY KEY") {
      table.primaryKey = cols;
    } else if (first.ctype === "UNIQUE") {
      table.uniques.push(cols);
    } else if (first.ctype === "FOREIGN KEY" && first.ref_table) {
      const fk: ForeignKey = {
        columns: cols,
        refTable: `${first.ref_schema ?? first.schema}.${first.ref_table}`,
        refColumns: rows.map((r) => r.ref_column!).filter(Boolean),
      };
      table.foreignKeys.push(fk);
    }
  }

  // CHECK constraints exist only on MySQL 8.0.16+ / MariaDB 10.2+; tolerate absence.
  try {
    const checkRes = await client.query<CheckRow>(CHECK_SQL, [schemas]);
    for (const row of checkRes.rows) {
      const table = tables.get(`${row.schema}.${row.table_name}`);
      if (table && row.check_clause) {
        table.checks.push({ expr: normalizeMysqlCheck(row.check_clause) });
      }
    }
  } catch {
    // Older server without information_schema.CHECK_CONSTRAINTS — no checks to apply.
  }

  return { tables };
}
