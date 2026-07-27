/** Reads a live Postgres schema into our internal representation via pg_catalog. */

import type { Client } from "pg";
import type {
  ColumnInfo,
  CompositeField,
  ForeignKey,
  PartitionInfo,
  Schema,
  TableInfo,
  TypeRef,
} from "./types.js";

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

/** Full type resolution beyond the plain category: elements, fields, subtypes. */
export interface ResolvedType extends TypeRef {
  elementType?: TypeRef;
  compositeFields?: CompositeField[];
  rangeSubtype?: TypeRef;
  /** Set when the declared type is a DOMAIN, so its CHECKs can be applied. */
  domainOid?: string;
}

interface PgType {
  typname: string;
  typtype: string;
  typbasetype: string;
  typelem: string;
  typcategory: string;
  typrelid: string;
  rngsubtype: string | null;
}

const TYPE_SQL = `
  SELECT t.oid, t.typname, t.typtype, t.typbasetype, t.typelem,
         t.typcategory, t.typrelid, r.rngsubtype
  FROM pg_type t
  LEFT JOIN pg_range r ON r.rngtypid = t.oid;
`;

const COMPOSITE_FIELD_SQL = `
  SELECT a.attrelid AS typrelid, a.attname, a.atttypid, a.attnum
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  WHERE c.relkind = 'c' AND a.attnum > 0 AND NOT a.attisdropped
  ORDER BY a.attrelid, a.attnum;
`;

const DOMAIN_CHECK_SQL = `
  SELECT con.contypid AS domain_oid, pg_get_expr(con.conbin, 0) AS expr
  FROM pg_constraint con
  WHERE con.contype = 'c' AND con.contypid <> 0;
`;

/**
 * Builds a type resolver that walks domains, arrays, composites, and ranges
 * down to the metadata generation needs. Uses the enum-label map already built
 * from pg_enum.
 */
async function buildTypeResolver(
  client: Client,
  enumsByOid: Map<string, string[]>,
): Promise<(oid: string | number) => ResolvedType> {
  const typeRes = await client.query<PgType & { oid: string }>(TYPE_SQL);
  const catalog = new Map<string, PgType>();
  for (const row of typeRes.rows) catalog.set(String(row.oid), row);

  const fieldRes = await client.query(COMPOSITE_FIELD_SQL);
  const compositeFields = new Map<string, { attname: string; atttypid: string }[]>();
  for (const row of fieldRes.rows) {
    const list = compositeFields.get(String(row.typrelid)) ?? [];
    list.push({ attname: row.attname, atttypid: String(row.atttypid) });
    compositeFields.set(String(row.typrelid), list);
  }

  const ref = (r: ResolvedType): TypeRef => ({
    udtName: r.udtName,
    dataType: r.dataType,
    enumValues: r.enumValues,
  });

  function resolve(oidRaw: string | number, seen = new Set<string>()): ResolvedType {
    const oid = String(oidRaw);
    const t = catalog.get(oid);
    if (!t || seen.has(oid)) return { udtName: t?.typname ?? "text", dataType: "text", enumValues: null };
    seen.add(oid);
    try {
      if (t.typtype === "d") {
        return { ...resolve(t.typbasetype, seen), domainOid: oid };
      }
      if (t.typtype === "e") {
        return { udtName: t.typname, dataType: "enum", enumValues: enumsByOid.get(oid) ?? null };
      }
      if (t.typtype === "c") {
        const fields: CompositeField[] = (compositeFields.get(String(t.typrelid)) ?? []).map((fld) => ({
          name: fld.attname,
          ...ref(resolve(fld.atttypid, seen)),
        }));
        return { udtName: t.typname, dataType: "composite", enumValues: null, compositeFields: fields };
      }
      if (t.typtype === "r") {
        const sub = t.rngsubtype ? ref(resolve(t.rngsubtype, seen)) : { udtName: "text", dataType: "text", enumValues: null };
        return { udtName: t.typname, dataType: "range", enumValues: null, rangeSubtype: sub };
      }
      if (t.typcategory === "A" && t.typelem && t.typelem !== "0") {
        return { udtName: t.typname, dataType: "array", enumValues: null, elementType: ref(resolve(t.typelem, seen)) };
      }
      return { udtName: t.typname, dataType: categorize(t.typname, null), enumValues: null };
    } finally {
      seen.delete(oid);
    }
  }

  return (oid) => resolve(oid);
}

/** Fetch domain oid -> CHECK expression texts (operands use the `VALUE` keyword). */
async function loadDomainChecks(client: Client): Promise<Map<string, string[]>> {
  const res = await client.query(DOMAIN_CHECK_SQL);
  const out = new Map<string, string[]>();
  for (const row of res.rows) {
    if (!row.expr) continue;
    const list = out.get(String(row.domain_oid)) ?? [];
    list.push(row.expr);
    out.set(String(row.domain_oid), list);
  }
  return out;
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
  WHERE c.relkind IN ('r', 'p')     -- ordinary + partitioned parent tables
    AND NOT c.relispartition        -- but not leaf partitions (we insert via the parent)
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

// Partitioned parents: their strategy and the attnums of the partition key.
const PARTITION_SQL = `
  SELECT
    n.nspname     AS schema,
    c.relname     AS table_name,
    p.partstrat   AS strategy,
    p.partattrs   AS partattrs
  FROM pg_partitioned_table p
  JOIN pg_class c     ON c.oid = p.partrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = ANY($1)
    AND NOT c.relispartition;
`;

// The bound clause of every partition, e.g. "FOR VALUES FROM ('2024...') TO ('2025...')".
const PARTITION_BOUND_SQL = `
  SELECT
    pn.nspname AS parent_schema,
    pc.relname AS parent_table,
    pg_get_expr(child.relpartbound, child.oid) AS bound
  FROM pg_inherits inh
  JOIN pg_class child   ON child.oid = inh.inhrelid
  JOIN pg_class pc      ON pc.oid = inh.inhparent
  JOIN pg_namespace pn  ON pn.oid = pc.relnamespace
  WHERE pn.nspname = ANY($1)
    AND child.relispartition;
`;

const STRATEGY: Record<string, PartitionInfo["strategy"]> = { r: "range", l: "list", h: "hash" };

/** Read partitioning metadata and attach it to the matching parent tables. */
async function loadPartitions(
  client: Client,
  schemas: string[],
  tables: Map<string, TableInfo>,
  attnumMap: Map<string, Map<number, string>>,
): Promise<void> {
  const partRes = await client.query(PARTITION_SQL, [schemas]);
  for (const row of partRes.rows) {
    const key = `${row.schema}.${row.table_name}`;
    const table = tables.get(key);
    const attnums = attnumMap.get(key);
    if (!table || !attnums) continue;
    // partattrs is an int2vector rendered as space-separated attnums; 0 marks an
    // expression key we can't constrain by column name.
    const attrs = String(row.partattrs).trim().split(/\s+/).filter(Boolean).map(Number);
    const keyColumns = attrs.every((n) => n > 0)
      ? attrs.map((n) => attnums.get(n)!).filter(Boolean)
      : [];
    table.partition = {
      strategy: STRATEGY[row.strategy] ?? "range",
      keyColumns,
      hasDefault: false,
      ranges: [],
      list: [],
    };
  }

  const boundRes = await client.query(PARTITION_BOUND_SQL, [schemas]);
  for (const row of boundRes.rows) {
    const table = tables.get(`${row.parent_schema}.${row.parent_table}`);
    if (!table?.partition || !row.bound) continue;
    applyBound(table.partition, row.bound);
  }
}

/** Fold one partition's bound clause into its parent's PartitionInfo. */
function applyBound(part: PartitionInfo, bound: string): void {
  const b = bound.trim();
  if (/^DEFAULT$/i.test(b)) {
    part.hasDefault = true;
    return;
  }
  if (part.strategy === "range") {
    const m = b.match(/^FOR\s+VALUES\s+FROM\s*\((.*)\)\s*TO\s*\((.*)\)$/is);
    if (!m) return;
    part.ranges!.push({ from: firstBoundValue(m[1]), to: firstBoundValue(m[2]) });
  } else if (part.strategy === "list") {
    const m = b.match(/^FOR\s+VALUES\s+IN\s*\((.*)\)$/is);
    if (!m) return;
    for (const v of splitTuple(m[1])) {
      const val = unquoteLiteral(v);
      if (val !== null) part.list!.push(val);
    }
  }
  // hash partitions need no value constraint (all keys route somewhere).
}

/** First element of a range bound tuple, or null for MINVALUE/MAXVALUE. */
function firstBoundValue(tuple: string): string | null {
  const first = splitTuple(tuple)[0]?.trim();
  if (!first || /^(MINVALUE|MAXVALUE)$/i.test(first)) return null;
  return unquoteLiteral(first);
}

/** Split a comma-separated bound tuple at the top level (respecting quotes). */
function splitTuple(s: string): string[] {
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

/** Strip a `'...'::type` cast/quoting to the raw scalar text, or null. */
function unquoteLiteral(s: string): string | null {
  let t = s.trim().replace(/::\s*[a-zA-Z_][\w .]*(\(\d+(,\d+)?\))?(\[\])?$/, "").trim();
  const q = t.match(/^'((?:[^']|'')*)'$/);
  if (q) return q[1].replace(/''/g, "'");
  return t.length ? t : null;
}

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

  const resolveType = await buildTypeResolver(client, enumsByOid);
  const domainChecks = await loadDomainChecks(client);

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
    const rt = resolveType(row.type_oid);
    const col: ColumnInfo = {
      name: row.column_name,
      udtName: row.udt_name,
      dataType: rt.dataType,
      elementType: rt.elementType,
      compositeFields: rt.compositeFields,
      rangeSubtype: rt.rangeSubtype,
      nullable: row.nullable,
      hasDefault: row.has_default,
      defaultExpr: row.default_expr,
      isIdentity: row.is_identity,
      isGenerated: row.is_generated,
      maxLength: row.max_length ?? null,
      enumValues: rt.enumValues,
      numericPrecision: row.numeric_precision ?? null,
      numericScale: row.numeric_scale ?? null,
    };
    table.columns.push(col);
    attnumMap.get(key)!.set(row.ordinal, row.column_name);

    // A domain column inherits its type's CHECKs; rewrite `VALUE` to the column
    // so the ordinary check parser can bound the generated value.
    if (rt.domainOid) {
      for (const expr of domainChecks.get(rt.domainOid) ?? []) {
        table.checks.push({ expr: expr.replace(/\bVALUE\b/g, `"${col.name}"`) });
      }
    }
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

  await loadPartitions(client, schemas, tables, attnumMap);

  return { tables };
}
