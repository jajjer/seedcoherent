/** Reads a live Postgres schema into our internal representation via pg_catalog. */

import type { Client } from "pg";
import type { ColumnInfo, ForeignKey, Schema, TableInfo } from "./types.js";

/** Postgres udt/base type name -> broad category we generate against. */
export function categorize(udtName: string, enumValues: string[] | null): string {
  if (enumValues) return "enum";
  if (udtName.startsWith("_")) return "array";
  switch (udtName) {
    case "int2":
    case "int4":
    case "int8":
      return "integer";
    case "float4":
    case "float8":
    case "numeric":
      return "decimal";
    case "bool":
      return "boolean";
    case "uuid":
      return "uuid";
    case "json":
    case "jsonb":
      return "json";
    case "date":
      return "date";
    case "time":
    case "timetz":
      return "time";
    case "timestamp":
    case "timestamptz":
      return "timestamp";
    case "bytea":
      return "bytea";
    case "inet":
    case "cidr":
      return "inet";
    case "text":
    case "varchar":
    case "bpchar":
    case "citext":
    case "name":
      return "text";
    default:
      return "text";
  }
}

const COLUMN_SQL = `
  SELECT
    n.nspname                                  AS schema,
    c.relname                                  AS table_name,
    a.attname                                  AS column_name,
    a.attnum                                   AS ordinal,
    t.typname                                  AS udt_name,
    NOT a.attnotnull                           AS nullable,
    (a.atthasdef AND ad.adbin IS NOT NULL)     AS has_default,
    pg_get_expr(ad.adbin, ad.adrelid)          AS default_expr,
    (a.attidentity <> '')                      AS is_identity,
    (a.attgenerated <> '')                     AS is_generated,
    information_schema._pg_char_max_length(a.atttypid, a.atttypmod) AS max_length,
    information_schema._pg_numeric_precision(a.atttypid, a.atttypmod) AS numeric_precision,
    information_schema._pg_numeric_scale(a.atttypid, a.atttypmod)     AS numeric_scale,
    t.typtype                                  AS type_kind,
    t.oid                                      AS type_oid
  FROM pg_attribute a
  JOIN pg_class c        ON c.oid = a.attrelid
  JOIN pg_namespace n    ON n.oid = c.relnamespace
  JOIN pg_type t         ON t.oid = a.atttypid
  LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
  WHERE c.relkind = 'r'
    AND a.attnum > 0
    AND NOT a.attisdropped
    AND n.nspname = ANY($1)
  ORDER BY n.nspname, c.relname, a.attnum;
`;

const ENUM_SQL = `
  SELECT t.oid AS type_oid, e.enumlabel AS label
  FROM pg_enum e
  JOIN pg_type t ON t.oid = e.enumtypid
  ORDER BY e.enumsortorder;
`;

const CONSTRAINT_SQL = `
  SELECT
    n.nspname            AS schema,
    c.relname           AS table_name,
    con.contype         AS contype,
    con.conkey          AS conkey,
    con.confkey         AS confkey,
    fn.nspname          AS ref_schema,
    fc.relname          AS ref_table,
    pg_get_expr(con.conbin, con.conrelid) AS check_expr
  FROM pg_constraint con
  JOIN pg_class c       ON c.oid = con.conrelid
  JOIN pg_namespace n   ON n.oid = c.relnamespace
  LEFT JOIN pg_class fc     ON fc.oid = con.confrelid
  LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
  WHERE con.contype IN ('p', 'u', 'f', 'c')
    AND n.nspname = ANY($1);
`;

export async function introspect(client: Client, schemas: string[] = ["public"]): Promise<Schema> {
  // Enums first: map type oid -> ordered labels.
  const enumRes = await client.query<{ type_oid: string; label: string }>(ENUM_SQL);
  const enumsByOid = new Map<string, string[]>();
  for (const row of enumRes.rows) {
    const oid = String(row.type_oid);
    const list = enumsByOid.get(oid) ?? [];
    list.push(row.label);
    enumsByOid.set(oid, list);
  }

  const colRes = await client.query(COLUMN_SQL, [schemas]);
  const tables = new Map<string, TableInfo>();
  // attnum -> column name, per table, so we can resolve constraint conkey arrays.
  const attnumMap = new Map<string, Map<number, string>>();

  for (const row of colRes.rows) {
    const key = `${row.schema}.${row.table_name}`;
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
      attnumMap.set(key, new Map());
    }
    const enumValues = row.type_kind === "e" ? enumsByOid.get(String(row.type_oid)) ?? null : null;
    const col: ColumnInfo = {
      name: row.column_name,
      udtName: row.udt_name,
      dataType: categorize(row.udt_name, enumValues),
      nullable: row.nullable,
      hasDefault: row.has_default,
      defaultExpr: row.default_expr,
      isIdentity: row.is_identity,
      isGenerated: row.is_generated,
      maxLength: row.max_length ?? null,
      enumValues,
      numericPrecision: row.numeric_precision ?? null,
      numericScale: row.numeric_scale ?? null,
    };
    table.columns.push(col);
    attnumMap.get(key)!.set(row.ordinal, row.column_name);
  }

  const conRes = await client.query(CONSTRAINT_SQL, [schemas]);
  for (const row of conRes.rows) {
    const key = `${row.schema}.${row.table_name}`;
    const table = tables.get(key);
    const attnums = attnumMap.get(key);
    if (!table || !attnums) continue;

    if (row.contype === "c") {
      if (row.check_expr) table.checks.push({ expr: row.check_expr });
      continue;
    }

    const cols: string[] = (row.conkey as number[]).map((n) => attnums.get(n)!).filter(Boolean);

    if (row.contype === "p") {
      table.primaryKey = cols;
    } else if (row.contype === "u") {
      table.uniques.push(cols);
    } else if (row.contype === "f") {
      const refKey = `${row.ref_schema}.${row.ref_table}`;
      const refAttnums = attnumMap.get(refKey);
      const refColumns: string[] = refAttnums
        ? (row.confkey as number[]).map((n) => refAttnums.get(n)!).filter(Boolean)
        : [];
      const fk: ForeignKey = { columns: cols, refTable: refKey, refColumns };
      table.foreignKeys.push(fk);
    }
  }

  return { tables };
}
