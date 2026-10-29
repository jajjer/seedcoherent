/** Reads a live SQL Server schema into our internal representation via the sys.* catalog. */

import { rewriteInLists } from "./checks.js";
import type {
  ColumnInfo,
  Connection,
  ForeignKey,
  Schema,
  TableInfo,
} from "./types.js";

/**
 * SQL Server type name -> broad category we generate against. Categories match
 * the Postgres/MySQL introspectors so the shared inference/generation layer stays
 * dialect-agnostic. SQL Server has no native JSON, array, enum, composite, or
 * range types (JSON lives in an `nvarchar` column), so those stay Postgres-only.
 */
export function categorizeMssql(dataType: string): string {
  switch (dataType.toLowerCase()) {
    case "tinyint":
    case "smallint":
    case "int":
    case "bigint":
      return "integer";
    case "bit":
      return "boolean";
    case "decimal":
    case "numeric":
    case "money":
    case "smallmoney":
    case "float":
    case "real":
      return "decimal";
    case "date":
      return "date";
    case "time":
      return "time";
    case "datetime":
    case "datetime2":
    case "smalldatetime":
    case "datetimeoffset":
      return "timestamp";
    case "uniqueidentifier":
      return "uuid";
    case "char":
    case "varchar":
    case "nchar":
    case "nvarchar":
    case "text":
    case "ntext":
    case "xml":
    case "sysname":
      return "text";
    case "binary":
    case "varbinary":
    case "image":
      return "bytea";
    default:
      // rowversion/timestamp (auto-generated), spatial, sql_variant, hierarchyid,
      // and anything else we can't emit a valid literal for. Flag "unsupported"
      // so generation NULLs/skips or errors clearly instead of guessing.
      return "unsupported";
  }
}

/**
 * Rewrite a SQL Server CHECK definition into the shape our (Postgres-oriented)
 * check parser understands: `[bracket]` identifiers become double-quoted, the
 * `N'...'` unicode-string introducer is stripped, and `IN (...)` value lists
 * become `= ANY (ARRAY[...])`. Common numeric-range, length, and membership
 * bounds carry over; forms we can't parse are simply left unconstrained.
 */
export function normalizeMssqlCheck(clause: string): string {
  const requoted = clause
    .replace(
      /\[((?:[^\]]|\]\])*)\]/g,
      (_, id: string) => `"${id.replace(/\]\]/g, "]")}"`,
    )
    .replace(/\bN'/g, "'");
  return rewriteInLists(requoted);
}

/** SQL Server stores n-char lengths in bytes; return the declared length in characters. */
function charLength(
  dataType: string,
  maxLenBytes: number | null,
): number | null {
  if (maxLenBytes === null || maxLenBytes < 0) return null; // -1 = MAX, treat as unbounded
  switch (dataType.toLowerCase()) {
    case "nchar":
    case "nvarchar":
      return maxLenBytes / 2;
    case "char":
    case "varchar":
      return maxLenBytes;
    default:
      return null;
  }
}

interface ColumnRow {
  schema: string;
  table_name: string;
  column_name: string;
  ordinal: number;
  data_type: string;
  max_length: number | null;
  precision: number | null;
  scale: number | null;
  is_nullable: boolean | number;
  is_identity: boolean | number;
  is_computed: boolean | number;
  has_default: boolean | number;
  default_expr: string | null;
}

interface ConstraintRow {
  schema: string;
  table_name: string;
  cname: string;
  ctype: string;
  column_name: string;
  ref_schema: string | null;
  ref_table: string | null;
  ref_column: string | null;
}

interface CheckRow {
  schema: string;
  table_name: string;
  check_clause: string;
}

/** `(@p1, @p2, ...)` placeholder list for a positional-param IN clause. */
function inList(count: number): string {
  return `(${Array.from({ length: count }, (_, i) => `@p${i + 1}`).join(", ")})`;
}

const TABLE_SQL = (ph: string) => `
  SELECT s.name AS [schema], t.name AS table_name
  FROM sys.tables t
  JOIN sys.schemas s ON s.schema_id = t.schema_id
  WHERE s.name IN ${ph};
`;

const COLUMN_SQL = (ph: string) => `
  SELECT
    s.name                  AS [schema],
    t.name                  AS table_name,
    c.name                  AS column_name,
    c.column_id             AS ordinal,
    TYPE_NAME(c.user_type_id) AS data_type,
    c.max_length            AS max_length,
    c.precision             AS precision,
    c.scale                 AS scale,
    c.is_nullable           AS is_nullable,
    c.is_identity           AS is_identity,
    c.is_computed           AS is_computed,
    CASE WHEN c.default_object_id <> 0 THEN 1 ELSE 0 END AS has_default,
    dc.definition           AS default_expr
  FROM sys.columns c
  JOIN sys.tables t  ON t.object_id = c.object_id
  JOIN sys.schemas s ON s.schema_id = t.schema_id
  LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
  WHERE s.name IN ${ph}
  ORDER BY s.name, t.name, c.column_id;
`;

// PRIMARY KEY + UNIQUE constraints and standalone UNIQUE indexes, with their
// columns in key order. UNION keeps composite keys grouped by (schema, table,
// constraint) so the caller can reassemble multi-column keys in order.
const KEY_SQL = (ph: string) => `
  SELECT s.name AS [schema], t.name AS table_name, kc.name AS cname,
         CASE kc.type WHEN 'PK' THEN 'PRIMARY KEY' ELSE 'UNIQUE' END AS ctype,
         c.name AS column_name, ic.key_ordinal AS ordinal
  FROM sys.key_constraints kc
  JOIN sys.tables t  ON t.object_id = kc.parent_object_id
  JOIN sys.schemas s ON s.schema_id = t.schema_id
  JOIN sys.index_columns ic ON ic.object_id = kc.parent_object_id AND ic.index_id = kc.unique_index_id
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE s.name IN ${ph}
  UNION ALL
  SELECT s.name, t.name, i.name, 'UNIQUE', c.name, ic.key_ordinal
  FROM sys.indexes i
  JOIN sys.tables t  ON t.object_id = i.object_id
  JOIN sys.schemas s ON s.schema_id = t.schema_id
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE s.name IN ${ph}
    AND i.is_unique = 1 AND i.is_primary_key = 0 AND i.is_unique_constraint = 0
    AND ic.is_included_column = 0
  ORDER BY [schema], table_name, cname, ordinal;
`;

const FK_SQL = (ph: string) => `
  SELECT s.name AS [schema], t.name AS table_name, fk.name AS cname,
         cpa.name AS column_name,
         rs.name AS ref_schema, rt.name AS ref_table, cref.name AS ref_column,
         fkc.constraint_column_id AS ordinal
  FROM sys.foreign_keys fk
  JOIN sys.tables t  ON t.object_id = fk.parent_object_id
  JOIN sys.schemas s ON s.schema_id = t.schema_id
  JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
  JOIN sys.columns cpa  ON cpa.object_id = fkc.parent_object_id AND cpa.column_id = fkc.parent_column_id
  JOIN sys.tables rt    ON rt.object_id = fk.referenced_object_id
  JOIN sys.schemas rs   ON rs.schema_id = rt.schema_id
  JOIN sys.columns cref ON cref.object_id = fkc.referenced_object_id AND cref.column_id = fkc.referenced_column_id
  WHERE s.name IN ${ph}
  ORDER BY s.name, t.name, fk.name, fkc.constraint_column_id;
`;

const CHECK_SQL = (ph: string) => `
  SELECT s.name AS [schema], t.name AS table_name, cc.definition AS check_clause
  FROM sys.check_constraints cc
  JOIN sys.tables t  ON t.object_id = cc.parent_object_id
  JOIN sys.schemas s ON s.schema_id = t.schema_id
  WHERE s.name IN ${ph};
`;

const toNum = (v: number | string | null): number | null =>
  v === null || v === undefined ? null : Number(v);
const toBool = (v: boolean | number): boolean => v === true || v === 1;

export async function introspectMssql(
  client: Connection,
  schemas: string[],
): Promise<Schema> {
  const ph = inList(schemas.length);

  const tableRes = await client.query<{ schema: string; table_name: string }>(
    TABLE_SQL(ph),
    schemas,
  );
  const baseTables = new Set(
    tableRes.rows.map((r) => `${r.schema}.${r.table_name}`),
  );

  const colRes = await client.query<ColumnRow>(COLUMN_SQL(ph), schemas);
  const tables = new Map<string, TableInfo>();

  for (const row of colRes.rows) {
    const key = `${row.schema}.${row.table_name}`;
    if (!baseTables.has(key)) continue;
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
    const dataType = categorizeMssql(row.data_type);
    const isIdentity = toBool(row.is_identity);
    // A rowversion/timestamp column is auto-maintained — never insertable — so it
    // reads as "unsupported"; treat it as DB-assigned so we leave it out of inserts.
    const isComputed =
      toBool(row.is_computed) ||
      (dataType === "unsupported" &&
        /^(rowversion|timestamp)$/i.test(row.data_type));
    const col: ColumnInfo = {
      name: row.column_name,
      udtName: row.data_type,
      dataType,
      nullable: toBool(row.is_nullable),
      hasDefault: toBool(row.has_default) || isIdentity,
      defaultExpr: row.default_expr,
      isIdentity,
      isGenerated: isComputed,
      maxLength: charLength(row.data_type, toNum(row.max_length)),
      enumValues: null,
      numericPrecision: dataType === "decimal" ? toNum(row.precision) : null,
      numericScale: dataType === "decimal" ? toNum(row.scale) : null,
    };
    table.columns.push(col);
  }

  const keyRes = await client.query<ConstraintRow>(KEY_SQL(ph), schemas);
  groupConstraints(keyRes.rows, baseTables, tables);

  const fkRes = await client.query<ConstraintRow>(FK_SQL(ph), schemas);
  groupConstraints(fkRes.rows, baseTables, tables, true);

  const checkRes = await client.query<CheckRow>(CHECK_SQL(ph), schemas);
  for (const row of checkRes.rows) {
    const table = tables.get(`${row.schema}.${row.table_name}`);
    if (table && row.check_clause) {
      table.checks.push({ expr: normalizeMssqlCheck(row.check_clause) });
    }
  }

  return { tables };
}

/** Fold PK/unique rows (or FK rows when `asForeignKey`) into their tables, keeping column order. */
function groupConstraints(
  rows: ConstraintRow[],
  baseTables: Set<string>,
  tables: Map<string, TableInfo>,
  asForeignKey = false,
): void {
  const byConstraint = new Map<string, ConstraintRow[]>();
  const order: string[] = [];
  for (const row of rows) {
    if (!baseTables.has(`${row.schema}.${row.table_name}`)) continue;
    const id = `${row.schema}.${row.table_name}.${row.cname}`;
    let list = byConstraint.get(id);
    if (!list) {
      byConstraint.set(id, (list = []));
      order.push(id);
    }
    list.push(row);
  }
  for (const id of order) {
    const group = byConstraint.get(id)!;
    const first = group[0];
    const table = tables.get(`${first.schema}.${first.table_name}`);
    if (!table) continue;
    const cols = group.map((r) => r.column_name);
    if (asForeignKey) {
      if (!first.ref_table) continue;
      const fk: ForeignKey = {
        columns: cols,
        refTable: `${first.ref_schema ?? first.schema}.${first.ref_table}`,
        refColumns: group.map((r) => r.ref_column!).filter(Boolean),
      };
      table.foreignKeys.push(fk);
    } else if (first.ctype === "PRIMARY KEY") {
      table.primaryKey = cols;
    } else {
      // Guard against listing the same unique column set twice (e.g. a unique
      // index backing a unique constraint shows up once from each query).
      const sig = cols.join("\u0000");
      if (!table.uniques.some((u) => u.join("\u0000") === sig))
        table.uniques.push(cols);
    }
  }
}
