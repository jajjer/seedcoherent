/**
 * Offline DDL front-end for MySQL and SQLite. The Postgres path (schema-file.ts)
 * leans on `pgsql-ast-parser`, which only understands Postgres grammar — MySQL's
 * backticks, `AUTO_INCREMENT`, inline `ENUM(...)`, and table options, and
 * SQLite's bracket identifiers, `AUTOINCREMENT`, and free-form type names all
 * trip it up. So this module hand-parses the `CREATE TABLE` / `CREATE INDEX` /
 * `ALTER TABLE` shapes both dialects share into the same internal `Schema`, and
 * reuses each live introspector's categorization + CHECK normalization so a
 * column's generation category matches what introspection would have derived.
 *
 * It's best-effort in the same spirit as the Postgres path: statements it can't
 * model (triggers, views, stored routines, table options) are skipped rather
 * than aborting the file.
 */

import {
  categorizeMysql,
  normalizeMysqlCheck,
  parseEnumValues,
} from "./mysql-introspect.js";
import { categorizeSqlite, normalizeSqliteCheck } from "./sqlite-introspect.js";
import type { ColumnInfo, ForeignKey, Schema, TableInfo } from "./types.js";

export type SqlDialect = "mysql" | "sqlite";

/** Column attribute / constraint keywords that end a column's type clause. */
const TYPE_STOP = new Set([
  "NOT",
  "NULL",
  "DEFAULT",
  "PRIMARY",
  "UNIQUE",
  "KEY",
  "REFERENCES",
  "CHECK",
  "GENERATED",
  "AS",
  "AUTO_INCREMENT",
  "AUTOINCREMENT",
  "COLLATE",
  "COMMENT",
  "ON",
  "CONSTRAINT",
  "STORED",
  "VIRTUAL",
  "VISIBLE",
  "INVISIBLE",
  "CHARACTER",
  "CHARSET",
]);

interface Tok {
  kind: "word" | "ident" | "str" | "num" | "punct";
  /** Words keep their original spelling; idents/strings are unquoted; puncts are the char. */
  text: string;
  start: number;
  end: number;
}

const isSpace = (c: string) => c === " " || c === "\t" || c === "\r" || c === "\n" || c === "\f";
const isDigit = (c: string) => c >= "0" && c <= "9";
const isWordStart = (c: string) => /[A-Za-z_]/.test(c);
const isWordChar = (c: string) => /[A-Za-z0-9_$]/.test(c);

/**
 * Tokenize a DDL script. Handles `--`/`#`/`/* *​/` comments, `'...'` strings, and
 * every identifier-quoting style the two dialects use: backticks (MySQL),
 * `[...]` brackets (SQLite), and `"..."` (a quoted identifier in SQLite, a string
 * literal in MySQL's default mode).
 */
function tokenize(sql: string, dialect: SqlDialect): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (isSpace(ch)) {
      i++;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (ch === "#") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === "`") {
      const start = i;
      i++;
      let text = "";
      while (i < n) {
        if (sql[i] === "`" && sql[i + 1] === "`") {
          text += "`";
          i += 2;
        } else if (sql[i] === "`") {
          i++;
          break;
        } else {
          text += sql[i++];
        }
      }
      toks.push({ kind: "ident", text, start, end: i });
      continue;
    }
    if (ch === "[") {
      const start = i;
      i++;
      let text = "";
      while (i < n && sql[i] !== "]") text += sql[i++];
      i++; // closing ]
      toks.push({ kind: "ident", text, start, end: i });
      continue;
    }
    if (ch === '"') {
      const start = i;
      i++;
      let text = "";
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          text += '"';
          i += 2;
        } else if (sql[i] === '"') {
          i++;
          break;
        } else {
          text += sql[i++];
        }
      }
      // MySQL (default sql_mode) reads "..." as a string; SQLite as an identifier.
      toks.push({ kind: dialect === "mysql" ? "str" : "ident", text, start, end: i });
      continue;
    }
    if (ch === "'") {
      const start = i;
      i++;
      let text = "";
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          text += "'";
          i += 2;
        } else if (sql[i] === "'") {
          i++;
          break;
        } else {
          text += sql[i++];
        }
      }
      toks.push({ kind: "str", text, start, end: i });
      continue;
    }
    if (isDigit(ch) || (ch === "." && isDigit(sql[i + 1]))) {
      const start = i;
      while (i < n && (isDigit(sql[i]) || sql[i] === ".")) i++;
      toks.push({ kind: "num", text: sql.slice(start, i), start, end: i });
      continue;
    }
    if (isWordStart(ch)) {
      const start = i;
      while (i < n && isWordChar(sql[i])) i++;
      toks.push({ kind: "word", text: sql.slice(start, i), start, end: i });
      continue;
    }
    toks.push({ kind: "punct", text: ch, start: i, end: i + 1 });
    i++;
  }
  return toks;
}

/** Uppercased text for a word token, or "" for anything else — for keyword compares. */
const kw = (t: Tok | undefined): string => (t && t.kind === "word" ? t.text.toUpperCase() : "");
const isPunct = (t: Tok | undefined, c: string): boolean => !!t && t.kind === "punct" && t.text === c;

/** Split a token stream into statements on top-level `;`. */
function statements(toks: Tok[]): Tok[][] {
  const out: Tok[][] = [];
  let cur: Tok[] = [];
  for (const t of toks) {
    if (isPunct(t, ";")) {
      if (cur.length) out.push(cur);
      cur = [];
    } else {
      cur.push(t);
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * From `pos` (at an opening `(`), return the index just past the matching `)`,
 * and the slice of tokens strictly inside the parentheses.
 */
function balancedParen(toks: Tok[], open: number): { inner: Tok[]; after: number } {
  let depth = 0;
  for (let i = open; i < toks.length; i++) {
    if (isPunct(toks[i], "(")) depth++;
    else if (isPunct(toks[i], ")") && --depth === 0) {
      return { inner: toks.slice(open + 1, i), after: i + 1 };
    }
  }
  return { inner: toks.slice(open + 1), after: toks.length };
}

/** Split a token list into top-level comma-separated groups (respecting nesting). */
function splitCommas(toks: Tok[]): Tok[][] {
  const out: Tok[][] = [];
  let cur: Tok[] = [];
  let depth = 0;
  for (const t of toks) {
    if (isPunct(t, "(")) depth++;
    else if (isPunct(t, ")")) depth--;
    if (isPunct(t, ",") && depth === 0) {
      if (cur.length) out.push(cur);
      cur = [];
    } else {
      cur.push(t);
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Read a possibly-qualified name (`db.table` / `table`) starting at `pos`. */
function readName(
  toks: Tok[],
  pos: number,
  defaultSchema: string,
): { schema: string; name: string; next: number } {
  const first = toks[pos];
  if (!first || (first.kind !== "word" && first.kind !== "ident")) {
    return { schema: defaultSchema, name: "", next: pos };
  }
  if (isPunct(toks[pos + 1], ".") && toks[pos + 2]) {
    return { schema: first.text, name: toks[pos + 2].text, next: pos + 3 };
  }
  return { schema: defaultSchema, name: first.text, next: pos + 1 };
}

/** Column names inside a `(a, b, c)` group — identifiers/words, commas ignored. */
function columnList(inner: Tok[]): string[] {
  return splitCommas(inner)
    .map((g) => g.find((t) => t.kind === "ident" || t.kind === "word")?.text ?? "")
    .filter(Boolean);
}

function emptyTable(schema: string, name: string): TableInfo {
  return {
    schema,
    name,
    key: `${schema}.${name}`,
    columns: [],
    primaryKey: [],
    uniques: [],
    foreignKeys: [],
    checks: [],
  };
}

/** Numeric type arguments, e.g. the `10, 2` of `DECIMAL(10, 2)` or `255` of `VARCHAR(255)`. */
function argNumbers(inner: Tok[]): number[] {
  return inner.filter((t) => t.kind === "num").map((t) => Number(t.text));
}

/**
 * Parse one column definition (name + type + attributes) and fold it, plus any
 * inline constraints it declares, into `table`.
 */
function parseColumn(
  group: Tok[],
  sql: string,
  dialect: SqlDialect,
  defaultSchema: string,
  table: TableInfo,
): void {
  const nameTok = group[0];
  const colName = nameTok.text;
  let p = 1;

  // Type clause: the first word is always the base type; keep consuming words
  // (and one `(...)` argument group) until an attribute keyword ends it.
  const typeStart = group[p]?.start ?? nameTok.end;
  let typeEnd = typeStart;
  let baseType = "";
  let argInner: Tok[] = [];
  let first = true;
  while (p < group.length) {
    const t = group[p];
    if (t.kind === "word") {
      if (!first && TYPE_STOP.has(t.text.toUpperCase())) break;
      if (first) baseType = t.text;
      typeEnd = t.end;
      first = false;
      p++;
      continue;
    }
    if (isPunct(t, "(")) {
      const { inner, after } = balancedParen(group, p);
      argInner = inner;
      typeEnd = group[after - 1]?.end ?? t.end;
      p = after;
      // A type's argument list ends the type clause (attributes follow).
      break;
    }
    break;
  }
  const rawType = sql.slice(typeStart, typeEnd).trim();

  // Resolve category, enum labels, and length/precision from the parsed type.
  let dataType: string;
  let enumValues: string[] | null = null;
  let udtName: string;
  let isSerial = false;
  if (dialect === "mysql") {
    let base = baseType.toLowerCase();
    let colType = rawType.toLowerCase();
    if (base === "boolean" || base === "bool") {
      base = "tinyint";
      colType = "tinyint(1)";
    } else if (base === "serial") {
      // MySQL SERIAL := BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE.
      isSerial = true;
      base = "bigint";
      colType = "bigint";
    }
    enumValues = parseEnumValues(colType);
    dataType = categorizeMysql(base, colType, enumValues);
    udtName = base;
  } else {
    dataType = categorizeSqlite(rawType);
    udtName = rawType || baseType;
  }

  const nums = argNumbers(argInner);
  let maxLength: number | null = null;
  let precision: number | null = null;
  let scale: number | null = null;
  if (dataType === "text" && nums.length) maxLength = nums[0];
  if (dataType === "decimal" && nums.length) {
    precision = nums[0] ?? null;
    scale = nums[1] ?? null;
  }

  const col: ColumnInfo = {
    name: colName,
    udtName,
    dataType,
    nullable: true,
    hasDefault: isSerial,
    defaultExpr: null,
    isIdentity: isSerial,
    isGenerated: false,
    maxLength,
    enumValues,
    numericPrecision: precision,
    numericScale: scale,
  };
  if (isSerial) table.uniques.push([colName]);

  // Attribute / inline-constraint loop over the rest of the definition.
  while (p < group.length) {
    const word = kw(group[p]);
    if (word === "NOT" && kw(group[p + 1]) === "NULL") {
      col.nullable = false;
      p += 2;
    } else if (word === "NULL") {
      col.nullable = true;
      p += 1;
    } else if (word === "PRIMARY" && kw(group[p + 1]) === "KEY") {
      col.nullable = false;
      table.primaryKey = [colName];
      p += 2;
    } else if (word === "UNIQUE") {
      table.uniques.push([colName]);
      p += kw(group[p + 1]) === "KEY" ? 2 : 1;
    } else if (word === "AUTO_INCREMENT" || word === "AUTOINCREMENT") {
      col.isIdentity = true;
      col.hasDefault = true;
      p += 1;
    } else if (word === "DEFAULT") {
      col.hasDefault = true;
      p = skipDefaultValue(group, p + 1);
    } else if (word === "GENERATED" || (word === "AS" && isPunct(group[p + 1], "("))) {
      col.isGenerated = true;
      p = skipGenerated(group, p);
    } else if (word === "REFERENCES") {
      const ref = readName(group, p + 1, defaultSchema);
      let refCols: string[] = [];
      let next = ref.next;
      if (isPunct(group[next], "(")) {
        const { inner, after } = balancedParen(group, next);
        refCols = columnList(inner);
        next = after;
      }
      table.foreignKeys.push({
        columns: [colName],
        refTable: `${ref.schema}.${ref.name}`,
        refColumns: refCols,
      });
      p = next;
    } else if (word === "CHECK" && isPunct(group[p + 1], "(")) {
      const { inner, after } = balancedParen(group, p + 1);
      pushCheck(table, sql, inner, dialect);
      p = after;
    } else if (word === "COLLATE" || word === "COMMENT") {
      p += 2; // keyword + its argument
    } else if (word === "CHARACTER" && kw(group[p + 1]) === "SET") {
      p += 3; // CHARACTER SET <name>
    } else if (word === "CHARSET") {
      p += 2;
    } else if (word === "ON" && (kw(group[p + 1]) === "UPDATE" || kw(group[p + 1]) === "DELETE")) {
      p = skipDefaultValue(group, p + 2); // ON UPDATE/DELETE <action>
    } else {
      p += 1; // permissively skip anything unrecognized
    }
  }

  table.columns.push(col);
}

/** Skip a DEFAULT value expression: a call, a parenthesized expr, or one literal/word. */
function skipDefaultValue(group: Tok[], pos: number): number {
  const t = group[pos];
  if (!t) return pos;
  if (isPunct(t, "(")) return balancedParen(group, pos).after;
  if (t.kind === "word" && isPunct(group[pos + 1], "(")) {
    return balancedParen(group, pos + 1).after; // now() / CURRENT_TIMESTAMP()
  }
  // A bare value: string, number, or keyword (TRUE / NULL / CURRENT_TIMESTAMP).
  return pos + 1;
}

/** Skip a generated-column clause: `GENERATED ALWAYS AS (expr) [STORED|VIRTUAL]` or `AS (expr)`. */
function skipGenerated(group: Tok[], pos: number): number {
  let p = pos;
  while (p < group.length && !isPunct(group[p], "(")) p++;
  if (isPunct(group[p], "(")) p = balancedParen(group, p).after;
  if (kw(group[p]) === "STORED" || kw(group[p]) === "VIRTUAL") p++;
  return p;
}

/** Normalize a CHECK expression's raw text per dialect and attach it to the table. */
function pushCheck(table: TableInfo, sql: string, inner: Tok[], dialect: SqlDialect): void {
  if (!inner.length) return;
  const raw = sql.slice(inner[0].start, inner[inner.length - 1].end);
  const expr = dialect === "mysql" ? normalizeMysqlCheck(raw) : normalizeSqliteCheck(raw);
  table.checks.push({ expr });
}

/** Parse a table-level item (a constraint or an index clause). Columns go elsewhere. */
function parseTableConstraint(
  group: Tok[],
  sql: string,
  dialect: SqlDialect,
  defaultSchema: string,
  table: TableInfo,
): void {
  let p = 0;
  if (kw(group[p]) === "CONSTRAINT") {
    // Skip `CONSTRAINT <name>`; the constraint keyword follows.
    p += group[p + 1] && group[p + 1].kind !== "punct" ? 2 : 1;
  }
  const head = kw(group[p]);
  if (head === "PRIMARY" && kw(group[p + 1]) === "KEY") {
    const open = group.findIndex((t, i) => i > p && isPunct(t, "("));
    if (open >= 0) table.primaryKey = columnList(balancedParen(group, open).inner);
  } else if (head === "UNIQUE") {
    const open = group.findIndex((t, i) => i > p && isPunct(t, "("));
    if (open >= 0) table.uniques.push(columnList(balancedParen(group, open).inner));
  } else if (head === "FOREIGN" && kw(group[p + 1]) === "KEY") {
    parseForeignKey(group, p + 2, defaultSchema, table);
  } else if (head === "CHECK") {
    const open = group.findIndex((t, i) => i > p && isPunct(t, "("));
    if (open >= 0) pushCheck(table, sql, balancedParen(group, open).inner, dialect);
  }
  // KEY / INDEX / FULLTEXT / SPATIAL (non-unique indexes) and anything else: ignored.
}

/** `FOREIGN KEY (cols) REFERENCES tbl (refcols)` starting at the local-column `(`. */
function parseForeignKey(
  group: Tok[],
  pos: number,
  defaultSchema: string,
  table: TableInfo,
): void {
  let p = pos;
  while (p < group.length && !isPunct(group[p], "(")) p++; // skip an optional index name
  if (!isPunct(group[p], "(")) return;
  const local = balancedParen(group, p);
  const cols = columnList(local.inner);
  p = local.after;
  if (kw(group[p]) !== "REFERENCES") return;
  const ref = readName(group, p + 1, defaultSchema);
  let refCols: string[] = [];
  p = ref.next;
  if (isPunct(group[p], "(")) {
    const refParen = balancedParen(group, p);
    refCols = columnList(refParen.inner);
  }
  const fk: ForeignKey = {
    columns: cols,
    refTable: `${ref.schema}.${ref.name}`,
    refColumns: refCols,
  };
  table.foreignKeys.push(fk);
}

/** `CREATE [TEMPORARY] TABLE [IF NOT EXISTS] name ( ... )`. */
function parseCreateTable(
  toks: Tok[],
  sql: string,
  dialect: SqlDialect,
  defaultSchema: string,
): TableInfo | null {
  let p = 1; // past CREATE
  while (["TEMPORARY", "TEMP", "GLOBAL", "LOCAL"].includes(kw(toks[p]))) p++;
  if (kw(toks[p]) !== "TABLE") return null;
  p++;
  if (kw(toks[p]) === "IF" && kw(toks[p + 1]) === "NOT" && kw(toks[p + 2]) === "EXISTS") p += 3;

  const named = readName(toks, p, defaultSchema);
  if (!named.name) return null;
  p = named.next;

  const open = toks.findIndex((t, i) => i >= p && isPunct(t, "("));
  if (open < 0) return null;
  const body = balancedParen(toks, open).inner;

  const table = emptyTable(named.schema, named.name);
  for (const group of splitCommas(body)) {
    if (!group.length) continue;
    if (isTableConstraint(group)) {
      parseTableConstraint(group, sql, dialect, defaultSchema, table);
    } else if (group[0].kind === "ident" || group[0].kind === "word") {
      parseColumn(group, sql, dialect, defaultSchema, table);
    }
  }
  return table;
}

/** Does this comma-group open a table-level constraint (vs. a column definition)? */
function isTableConstraint(group: Tok[]): boolean {
  const first = kw(group[0]);
  if (["PRIMARY", "UNIQUE", "FOREIGN", "CHECK", "CONSTRAINT", "KEY", "INDEX", "FULLTEXT", "SPATIAL"].includes(first)) {
    // `KEY`/`INDEX`/`UNIQUE`/`PRIMARY` are constraint leads only when not a column
    // name; a bare-word column literally named "key" would be quoted as an ident.
    return group[0].kind === "word";
  }
  return false;
}

/** `CREATE [UNIQUE] INDEX name ON table (cols)` — only unique indexes add a constraint. */
function parseCreateIndex(
  toks: Tok[],
  defaultSchema: string,
  tables: Map<string, TableInfo>,
): void {
  let p = 1; // past CREATE
  const unique = kw(toks[p]) === "UNIQUE";
  if (unique) p++;
  if (kw(toks[p]) !== "INDEX") return;
  if (!unique) return; // non-unique indexes don't constrain generation
  p++;
  if (kw(toks[p]) === "IF" && kw(toks[p + 1]) === "NOT" && kw(toks[p + 2]) === "EXISTS") p += 3;
  const idx = readName(toks, p, defaultSchema);
  p = idx.next;
  if (kw(toks[p]) !== "ON") return;
  const target = readName(toks, p + 1, defaultSchema);
  p = target.next;
  const open = toks.findIndex((t, i) => i >= p && isPunct(t, "("));
  if (open < 0) return;
  const table = tables.get(`${target.schema}.${target.name}`);
  if (!table) return;
  const cols = columnList(balancedParen(toks, open).inner);
  if (cols.length) table.uniques.push(cols);
}

/** `ALTER TABLE t ADD [CONSTRAINT n] {PRIMARY KEY|UNIQUE|FOREIGN KEY|CHECK} ...`. */
function parseAlterTable(
  toks: Tok[],
  sql: string,
  dialect: SqlDialect,
  defaultSchema: string,
  tables: Map<string, TableInfo>,
): void {
  let p = 2; // past ALTER TABLE
  if (kw(toks[p]) === "IF" && kw(toks[p + 1]) === "EXISTS") p += 2;
  const target = readName(toks, p, defaultSchema);
  const table = tables.get(`${target.schema}.${target.name}`);
  if (!table) return;
  p = target.next;
  for (const clause of splitCommas(toks.slice(p))) {
    let q = 0;
    if (kw(clause[q]) !== "ADD") continue;
    q++;
    if (kw(clause[q]) === "COLUMN") continue; // added columns aren't modeled offline
    parseTableConstraint(clause.slice(q), sql, dialect, defaultSchema, table);
  }
}

/**
 * Build a `Schema` from a MySQL or SQLite DDL script. Tables are collected
 * first, then `ALTER TABLE`/`CREATE INDEX` statements are folded in, then the
 * SQLite `INTEGER PRIMARY KEY` rowid alias is resolved — mirroring the live
 * introspector so an offline schema matches a connected one.
 */
export function loadSchemaFromSqlDdl(sql: string, dialect: SqlDialect): Schema {
  const stmts = statements(tokenize(sql, dialect));
  let defaultSchema = dialect === "sqlite" ? "main" : "public";
  const tables = new Map<string, TableInfo>();

  // First pass: `USE db` sets the default schema; `CREATE TABLE` builds tables.
  for (const toks of stmts) {
    const head = kw(toks[0]);
    if (dialect === "mysql" && head === "USE" && toks[1]) {
      defaultSchema = toks[1].text;
    } else if (head === "CREATE" && looksLikeCreateTable(toks)) {
      const table = parseCreateTable(toks, sql, dialect, defaultSchema);
      if (table) tables.set(table.key, table);
    }
  }

  // Second pass: constraints and indexes declared after their table.
  for (const toks of stmts) {
    const head = kw(toks[0]);
    if (head === "CREATE") parseCreateIndex(toks, defaultSchema, tables);
    else if (head === "ALTER" && kw(toks[1]) === "TABLE") {
      parseAlterTable(toks, sql, dialect, defaultSchema, tables);
    }
  }

  if (dialect === "sqlite") {
    for (const table of tables.values()) resolveRowidAlias(table);
  }
  return { tables };
}

/** A single-column `INTEGER PRIMARY KEY` is SQLite's auto-assigned rowid. */
function resolveRowidAlias(table: TableInfo): void {
  if (table.primaryKey.length !== 1) return;
  const pk = table.columns.find((c) => c.name === table.primaryKey[0]);
  if (pk && pk.udtName.trim().toUpperCase() === "INTEGER") {
    pk.isIdentity = true;
    pk.hasDefault = true;
  }
}

/** Cheap guard so `CREATE INDEX`/`CREATE VIEW`/… don't reach the table parser. */
function looksLikeCreateTable(toks: Tok[]): boolean {
  let p = 1;
  while (["TEMPORARY", "TEMP", "GLOBAL", "LOCAL"].includes(kw(toks[p]))) p++;
  return kw(toks[p]) === "TABLE";
}
