/**
 * Offline schema front-end: builds the same internal `Schema` the live
 * introspector produces, but from a `.sql`/DDL file instead of a database
 * connection. This lets `seedcoherent` generate seed data in CI or before any
 * database exists — point it at a migration/`pg_dump` script and write out SQL.
 *
 * It parses Postgres DDL with `pgsql-ast-parser` and maps `CREATE TABLE` /
 * `CREATE TYPE ... AS ENUM` / `ALTER TABLE ... ADD CONSTRAINT` statements onto
 * `TableInfo`/`ColumnInfo`, reusing `categorize()` so a column's generation
 * category matches what introspection would have derived. Statements the parser
 * can't handle (`SET`, `CREATE EXTENSION`, `CREATE DOMAIN`, `COMMENT`, …) are
 * skipped rather than aborting the run — best-effort, in the same spirit as the
 * live path's handling of shapes it can't fully model.
 */

import { parse } from "pgsql-ast-parser";
import { categorize } from "./introspect.js";
import { loadSchemaFromSqlDdl } from "./sql-ddl.js";
import type {
  ColumnInfo,
  ForeignKey,
  Schema,
  TableInfo,
  TypeRef,
} from "./types.js";

/** Which DDL grammar a schema file is written in — one front-end per engine. */
export type SchemaFileDialect = "postgres" | "mysql" | "sqlite";

/**
 * Friendly Postgres type names (as written in DDL) mapped to the `udt` name
 * `categorize()` expects. Anything not listed is passed through unchanged, so a
 * pg_catalog-style name (`int4`, `timestamptz`) already works, and an unknown
 * name falls through to `categorize()`'s `unsupported` bucket.
 */
const TYPE_ALIASES: Record<string, string> = {
  int: "int4",
  integer: "int4",
  int4: "int4",
  smallint: "int2",
  int2: "int2",
  bigint: "int8",
  int8: "int8",
  serial: "int4",
  serial4: "int4",
  bigserial: "int8",
  serial8: "int8",
  smallserial: "int2",
  serial2: "int2",
  boolean: "bool",
  bool: "bool",
  real: "float4",
  float4: "float4",
  "double precision": "float8",
  float8: "float8",
  decimal: "numeric",
  numeric: "numeric",
  "character varying": "varchar",
  varchar: "varchar",
  character: "bpchar",
  char: "bpchar",
  bpchar: "bpchar",
  text: "text",
  citext: "citext",
  timestamp: "timestamp",
  timestamptz: "timestamptz",
  "timestamp without time zone": "timestamp",
  "timestamp with time zone": "timestamptz",
  time: "time",
  timetz: "timetz",
  "time without time zone": "time",
  "time with time zone": "timetz",
  date: "date",
  uuid: "uuid",
  json: "json",
  jsonb: "jsonb",
  bytea: "bytea",
  inet: "inet",
  cidr: "cidr",
  money: "money",
  interval: "interval",
  macaddr: "macaddr",
  macaddr8: "macaddr8",
  xml: "xml",
};

/** `serial`/`bigserial`/`smallserial` imply a `nextval(...)` default. */
const SERIAL_TYPES = new Set(["serial", "serial4", "bigserial", "serial8", "smallserial", "serial2"]);

/** The parser represents names as `{ name, schema? }`; normalize to a string. */
function nameOf(n: any): string {
  return typeof n === "string" ? n : n?.name ?? "";
}

/** Resolve a DDL type-name node to the udt name + broad category we generate against. */
function resolveScalar(typeName: string, enums: Map<string, string[]>): TypeRef {
  const lower = typeName.toLowerCase();
  const enumValues = enums.get(lower) ?? null;
  if (enumValues) return { udtName: typeName, dataType: "enum", enumValues };
  const udt = TYPE_ALIASES[lower] ?? lower;
  return { udtName: udt, dataType: categorize(udt, null), enumValues: null };
}

/**
 * Full type resolution for a column's `dataType` AST node: scalars, arrays, and
 * `serial` (which carries an implicit integer type + default). Composites and
 * ranges declared in the file aren't modeled, so a column of such a type lands
 * in the `unsupported` bucket — handled exactly as the live path handles types
 * it can't synthesize.
 */
function resolveColumnType(
  dt: any,
  enums: Map<string, string[]>,
): { ref: TypeRef; elementType?: TypeRef; isSerial: boolean } {
  if (dt?.kind === "array" || dt?.arrayOf) {
    const elem = resolveScalar(nameOf(dt.arrayOf), enums);
    return {
      ref: { udtName: `_${elem.udtName}`, dataType: "array", enumValues: null },
      elementType: elem,
      isSerial: false,
    };
  }
  const name = nameOf(dt).toLowerCase();
  const ref = resolveScalar(nameOf(dt), enums);
  return { ref, isSerial: SERIAL_TYPES.has(name) };
}

/** `numeric(p, s)` / `varchar(n)` — pull length and precision/scale out of `config`. */
function typeConfig(dt: any): { maxLength: number | null; precision: number | null; scale: number | null } {
  const cfg: number[] = Array.isArray(dt?.config) ? dt.config : [];
  const base = nameOf(dt).toLowerCase();
  const isNumeric = base === "numeric" || base === "decimal";
  if (isNumeric) {
    return { maxLength: null, precision: cfg[0] ?? null, scale: cfg[1] ?? null };
  }
  // varchar(n)/char(n): the single config value is a character length.
  return { maxLength: cfg[0] ?? null, precision: null, scale: null };
}

/**
 * Render a parsed CHECK expression into the normalized text `checks.ts`
 * consumes. It targets the same shapes the live check parser recognizes —
 * numeric comparisons, `IN (...)`, `BETWEEN`, `char_length(...)`, `~` regex,
 * and top-level `AND` — and returns `null` for anything else, so an unrecognized
 * CHECK is simply skipped (never turned into a wrong bound).
 */
function renderCheck(expr: any): string | null {
  if (!expr || typeof expr !== "object") return null;
  switch (expr.type) {
    case "binary": {
      const op = expr.op;
      if (op === "AND") {
        const l = renderCheck(expr.left);
        const r = renderCheck(expr.right);
        if (l && r) return `${l} AND ${r}`;
        return l ?? r; // keep the conjunct we understand; drop the other
      }
      if (op === "IN" && expr.right?.type === "list") {
        const col = renderOperand(expr.left);
        const items = (expr.right.expressions as any[]).map(renderLiteral);
        if (!col || items.some((v) => v === null)) return null;
        return `${col} = ANY (ARRAY[${items.join(", ")}])`;
      }
      if ([">", ">=", "<", "<=", "=", "<>"].includes(op)) {
        const left = renderOperand(expr.left);
        const right = renderOperand(expr.right);
        if (left === null || right === null) return null;
        return `${left} ${op} ${right}`;
      }
      if (op === "~" || op === "~*") {
        const col = renderOperand(expr.left);
        const pat = renderLiteral(expr.right);
        if (!col || pat === null) return null;
        return `${col} ${op} ${pat}`;
      }
      return null;
    }
    case "ternary": {
      // `col BETWEEN lo AND hi` -> two inclusive bounds the range parser reads.
      if (expr.op !== "BETWEEN") return null;
      const col = renderOperand(expr.value);
      const lo = renderOperand(expr.lo);
      const hi = renderOperand(expr.hi);
      if (col === null || lo === null || hi === null) return null;
      return `${col} >= ${lo} AND ${col} <= ${hi}`;
    }
    default:
      return null;
  }
}

/** Render a comparison operand (a column ref, a number, a `char_length(col)` call, …). */
function renderOperand(node: any): string | null {
  if (!node || typeof node !== "object") return null;
  switch (node.type) {
    case "ref":
      return node.name;
    case "integer":
    case "numeric":
      return String(node.value);
    case "unary":
      if (node.op === "-") {
        const inner = renderOperand(node.operand);
        return inner === null ? null : `-${inner}`;
      }
      return null;
    case "string":
      return `'${String(node.value).replace(/'/g, "''")}'`;
    case "call": {
      const fn = nameOf(node.function).toLowerCase();
      if (["char_length", "length", "octet_length"].includes(fn) && node.args?.length === 1) {
        const arg = renderOperand(node.args[0]);
        return arg === null ? null : `${fn}(${arg})`;
      }
      return null;
    }
    default:
      return null;
  }
}

/** Render a literal node as SQL text (quoted string or bare number), else null. */
function renderLiteral(node: any): string | null {
  if (!node || typeof node !== "object") return null;
  if (node.type === "string") return `'${String(node.value).replace(/'/g, "''")}'`;
  if (node.type === "integer" || node.type === "numeric") return String(node.value);
  return null;
}

/**
 * Split a DDL script into top-level statements so each can be parsed on its own
 * and an unparseable one (an extension, a `SET`, a `CREATE DOMAIN`) skipped
 * without aborting the whole file. Respects `'...'` strings, `$tag$...$tag$`
 * dollar-quoting, and `--` / block comments.
 */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (ch === "'") {
      i++;
      while (i < n && !(sql[i] === "'" && sql[i + 1] !== "'")) i += sql[i] === "'" ? 2 : 1;
      i++;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === "$") {
      const tag = sql.slice(i).match(/^\$[A-Za-z0-9_]*\$/);
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        i = end === -1 ? n : end + tag[0].length;
        continue;
      }
    }
    if (ch === ";") {
      const stmt = sql.slice(start, i).trim();
      if (stmt) out.push(stmt);
      start = i + 1;
    }
    i++;
  }
  const tail = sql.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/** Parse each statement independently, discarding ones the parser rejects. */
function parseStatements(sql: string): any[] {
  const statements: any[] = [];
  for (const stmt of splitStatements(sql)) {
    try {
      for (const parsed of parse(stmt)) statements.push(parsed);
    } catch {
      // Unsupported/foreign statement — skip it, keep going.
    }
  }
  return statements;
}

/** Add a table-level (or promoted column-level) constraint to its TableInfo. */
function applyConstraint(table: TableInfo, con: any, enums: Map<string, string[]>): void {
  switch (con?.type) {
    case "primary key":
      table.primaryKey = (con.columns as any[]).map(nameOf);
      break;
    case "unique":
      table.uniques.push((con.columns as any[]).map(nameOf));
      break;
    case "foreign key": {
      const fk: ForeignKey = {
        columns: (con.localColumns as any[]).map(nameOf),
        refTable: qualifiedKey(con.foreignTable),
        refColumns: (con.foreignColumns as any[]).map(nameOf),
      };
      table.foreignKeys.push(fk);
      break;
    }
    case "check": {
      const expr = renderCheck(con.expr);
      if (expr) table.checks.push({ expr });
      break;
    }
  }
}

/** `schema.table` key, defaulting the schema to `public` as the live path does. */
function qualifiedKey(ref: any): string {
  const schema = ref?.schema ?? "public";
  return `${schema}.${nameOf(ref)}`;
}

/** Turn one parsed `CREATE TABLE` statement into a TableInfo. */
function buildTable(stmt: any, enums: Map<string, string[]>): TableInfo {
  const schema = stmt.name?.schema ?? "public";
  const name = nameOf(stmt.name);
  const table: TableInfo = {
    schema,
    name,
    key: `${schema}.${name}`,
    columns: [],
    primaryKey: [],
    uniques: [],
    foreignKeys: [],
    checks: [],
  };

  for (const entry of stmt.columns ?? []) {
    if (entry.kind !== "column") continue;
    const colName = nameOf(entry.name);
    const { ref, elementType, isSerial } = resolveColumnType(entry.dataType, enums);
    const { maxLength, precision, scale } = typeConfig(entry.dataType);

    const col: ColumnInfo = {
      name: colName,
      udtName: ref.udtName,
      dataType: ref.dataType,
      elementType,
      nullable: true,
      hasDefault: isSerial,
      defaultExpr: null,
      isIdentity: false,
      isGenerated: false,
      maxLength,
      enumValues: ref.enumValues,
      numericPrecision: precision,
      numericScale: scale,
    };

    for (const con of entry.constraints ?? []) {
      switch (con.type) {
        case "not null":
          col.nullable = false;
          break;
        case "null":
          col.nullable = true;
          break;
        case "default":
          col.hasDefault = true;
          break;
        case "primary key":
          col.nullable = false;
          table.primaryKey = [colName];
          break;
        case "unique":
          table.uniques.push([colName]);
          break;
        case "add generated":
          // GENERATED ... AS IDENTITY -> DB-assigned; AS (expr) STORED -> generated.
          if (con.expression) col.isGenerated = true;
          else col.isIdentity = true;
          break;
        case "check": {
          const expr = renderCheck(con.expr);
          if (expr) table.checks.push({ expr });
          break;
        }
        case "reference":
          table.foreignKeys.push({
            columns: [colName],
            refTable: qualifiedKey(con.foreignTable),
            refColumns: (con.foreignColumns as any[]).map(nameOf),
          });
          break;
      }
    }

    table.columns.push(col);
  }

  for (const con of stmt.constraints ?? []) applyConstraint(table, con, enums);
  return table;
}

/**
 * Build a `Schema` from a DDL file, dispatching to the right front-end for the
 * file's grammar: Postgres via `pgsql-ast-parser` here, MySQL and SQLite via the
 * hand-rolled parser in `sql-ddl.ts`. The three produce the same internal model,
 * so everything downstream (topo-sort, generation, emit) is dialect-agnostic.
 */
export function loadSchemaFromDdl(sql: string, dialect: SchemaFileDialect = "postgres"): Schema {
  if (dialect === "mysql" || dialect === "sqlite") return loadSchemaFromSqlDdl(sql, dialect);
  return loadPostgresDdl(sql);
}

/**
 * Postgres front-end. Two passes: first collect enum label sets (`CREATE TYPE
 * ... AS ENUM`) so columns typed by them resolve to `enum`, then build each
 * table; `ALTER TABLE ... ADD CONSTRAINT` is folded in last so a constraint
 * declared after its table still lands on it.
 */
function loadPostgresDdl(sql: string): Schema {
  const statements = parseStatements(sql);

  const enums = new Map<string, string[]>();
  for (const stmt of statements) {
    if (stmt.type === "create enum") {
      enums.set(nameOf(stmt.name).toLowerCase(), (stmt.values as any[]).map((v) => v.value));
    }
  }

  const tables = new Map<string, TableInfo>();
  for (const stmt of statements) {
    if (stmt.type !== "create table") continue;
    const table = buildTable(stmt, enums);
    tables.set(table.key, table);
  }

  for (const stmt of statements) {
    if (stmt.type !== "alter table") continue;
    const schema = stmt.table?.schema ?? "public";
    const table = tables.get(`${schema}.${nameOf(stmt.table)}`);
    if (!table) continue;
    for (const change of stmt.changes ?? []) {
      if (change.type === "add constraint") applyConstraint(table, change.constraint, enums);
    }
  }

  return { tables };
}
