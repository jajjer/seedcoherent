/** Turns generated TableData into SQL Server (T-SQL) text or streams it into a live DB. */

import { DEFAULT_BATCH_SIZE } from "./config.js";
import type { ScriptOptions } from "./emit.js";
import type { RowSink, Row, TableData } from "./generate.js";
import type { ColumnInfo, Connection, OnConflict, TableInfo } from "./types.js";

/** Bracket-quote a SQL Server identifier, doubling any embedded `]`. */
const IDENT = (s: string) => `[${s.replace(/\]/g, "]]")}]`;

/** Schema-qualified `[schema].[table]`. */
function tableRef(t: TableInfo): string {
  return `${IDENT(t.schema)}.${IDENT(t.name)}`;
}

/** Escape a T-SQL string-literal body: only the single quote is special. */
function escapeString(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * SQL Server `datetime2`/`datetime` literal, 'YYYY-MM-DD HH:MM:SS.mmm' in UTC.
 * No trailing `Z`: a bare space-separated form parses for every date/time type.
 */
function formatDate(d: Date): string {
  return d.toISOString().replace("T", " ").replace("Z", "");
}

/** Format a JS value as a T-SQL literal (for --out/--print scripts). `N'...'` keeps unicode. */
export function mssqlLiteral(v: unknown, _col: ColumnInfo): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") return String(v);
  if (typeof v === "bigint") return String(v);
  if (v instanceof Date) return `'${formatDate(v)}'`;
  if (Buffer.isBuffer(v)) return `0x${v.toString("hex")}`;
  if (Array.isArray(v) || typeof v === "object") {
    return `N'${escapeString(JSON.stringify(v))}'`;
  }
  return `N'${escapeString(String(v))}'`;
}

/** Does any emitted column carry an explicit identity value (needs IDENTITY_INSERT)? */
function hasIdentity(columns: ColumnInfo[]): boolean {
  return columns.some((c) => c.isIdentity);
}

/** The upsert target: primary key first, else the first unique constraint. */
function conflictTarget(table: TableInfo): string[] {
  return table.primaryKey.length > 0
    ? table.primaryKey
    : (table.uniques[0] ?? []);
}

/**
 * Convert a JS value into an `mssql` bind parameter. The driver infers the column
 * type from the JS type, so Dates/Buffers/numbers/strings pass through; booleans
 * map to `bit`; and objects/arrays (JSON stored in an nvarchar column) serialize.
 */
export function toParam(v: unknown, _col: ColumnInfo): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date || Buffer.isBuffer(v)) return v;
  if (Array.isArray(v) || typeof v === "object") return JSON.stringify(v);
  return v;
}

/**
 * Build a full, runnable T-SQL script. FK enforcement is relaxed per table
 * (`NOCHECK CONSTRAINT ALL`) so the script loads regardless of order, and
 * re-checked at the end. `--on-conflict` renders a `MERGE` (skip = insert-only,
 * update = insert-or-update); otherwise a plain multi-row `INSERT`.
 */
export function toSqlMssql(
  data: TableData[],
  opts: ScriptOptions = {},
): string {
  const nonEmpty = data.filter((d) => d.rows.length > 0);
  const parts: string[] = ["SET XACT_ABORT ON;", "BEGIN TRANSACTION;", ""];

  // Relax FK checks up front so any insert order (incl. cycles) loads.
  for (const { table } of nonEmpty)
    parts.push(`ALTER TABLE ${tableRef(table)} NOCHECK CONSTRAINT ALL;`);
  if (nonEmpty.length) parts.push("");

  for (const { table, rows, columns } of nonEmpty) {
    parts.push(`-- ${table.key}: ${rows.length} rows`);
    const identity = hasIdentity(columns);
    if (identity) parts.push(`SET IDENTITY_INSERT ${tableRef(table)} ON;`);
    parts.push(renderStatement(table, rows, columns, opts.onConflict));
    if (identity) parts.push(`SET IDENTITY_INSERT ${tableRef(table)} OFF;`);
    parts.push("");
  }

  // Re-enable + validate FK constraints now that every row is present.
  for (const { table } of nonEmpty)
    parts.push(
      `ALTER TABLE ${tableRef(table)} WITH CHECK CHECK CONSTRAINT ALL;`,
    );
  if (nonEmpty.length) parts.push("");

  parts.push("COMMIT;");
  return parts.join("\n");
}

/** One table's INSERT or MERGE statement (already filtered to non-empty rows). */
function renderStatement(
  table: TableInfo,
  rows: Row[],
  columns: ColumnInfo[],
  onConflict: OnConflict | undefined,
): string {
  const colList = columns.map((c) => IDENT(c.name)).join(", ");
  const valueRows = rows.map(
    (row) =>
      `  (${columns.map((c) => mssqlLiteral(row[c.name], c)).join(", ")})`,
  );
  const target = conflictTarget(table);

  // No conflict handling, or no key to match on: a plain multi-row INSERT.
  if (!onConflict || target.length === 0) {
    return (
      `INSERT INTO ${tableRef(table)} (${colList}) VALUES\n` +
      valueRows.join(",\n") +
      ";"
    );
  }

  // MERGE handles both skip (insert-only) and update (insert-or-update) against a
  // key target — SQL Server has no `ON CONFLICT`/`INSERT IGNORE` equivalent.
  const srcCols = columns.map((c) => IDENT(c.name)).join(", ");
  const on = target
    .map((k) => `tgt.${IDENT(k)} = src.${IDENT(k)}`)
    .join(" AND ");
  const insertVals = columns.map((c) => `src.${IDENT(c.name)}`).join(", ");

  const lines = [
    `MERGE INTO ${tableRef(table)} AS tgt`,
    `USING (VALUES\n${valueRows.join(",\n")}\n) AS src (${srcCols})`,
    `ON ${on}`,
  ];
  if (onConflict === "update") {
    const targetSet = new Set(target);
    const setCols = columns
      .filter((c) => !targetSet.has(c.name) && !c.isIdentity && !c.isGenerated)
      .map((c) => `${IDENT(c.name)} = src.${IDENT(c.name)}`);
    if (setCols.length > 0)
      lines.push(`WHEN MATCHED THEN UPDATE SET ${setCols.join(", ")}`);
  }
  lines.push(
    `WHEN NOT MATCHED THEN INSERT (${colList}) VALUES (${insertVals});`,
  );
  return lines.join("\n");
}

export interface CopyOptions {
  /** Empty the target tables (via DELETE, so it rolls back with the inserts). */
  truncate?: boolean;
  /** Tables that will be written, in dependency order (cleared in reverse). */
  tables?: TableInfo[];
}

/**
 * SQL Server caps a single request at 2100 parameters, so we bound each multi-row
 * INSERT to stay under that, and cap at 1000 value-rows (the `VALUES` row limit).
 */
const MAX_BIND_PARAMS = 2000;
const MAX_VALUE_ROWS = 1000;

/**
 * A {@link RowSink} that streams rows into SQL Server as batched multi-row
 * INSERTs inside one transaction. SQL Server has no COPY, so rows bind as `@pN`
 * parameters. Explicit identity values need `SET IDENTITY_INSERT ON` (one table
 * at a time); the identity seed is reset in `finalize` so later app inserts don't
 * collide. The pool is sized to a single connection (see dialect.ts) so the
 * transaction and IDENTITY_INSERT session state hold across statements.
 */
export class MssqlSink implements RowSink {
  private started = false;
  private currentTable: TableInfo | null = null;
  private currentCols: ColumnInfo[] = [];
  private readonly filled: TableInfo[] = [];
  private total = 0;

  constructor(
    private readonly conn: Connection,
    private readonly opts: CopyOptions = {},
    private readonly batchSize: number = DEFAULT_BATCH_SIZE,
  ) {}

  get inserted(): number {
    return this.total;
  }

  private async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.conn.query("SET XACT_ABORT ON");
    await this.conn.query("BEGIN TRANSACTION");
    if (this.opts.truncate && this.opts.tables?.length) {
      // Relax FK checks so tangled/circular graphs clear in any order.
      for (const t of this.opts.tables)
        await this.conn.query(
          `ALTER TABLE ${tableRef(t)} NOCHECK CONSTRAINT ALL`,
        );
      for (const t of [...this.opts.tables].reverse())
        await this.conn.query(`DELETE FROM ${tableRef(t)}`);
      for (const t of this.opts.tables)
        await this.conn.query(
          `ALTER TABLE ${tableRef(t)} WITH CHECK CHECK CONSTRAINT ALL`,
        );
    }
  }

  async begin(table: TableInfo, columns: ColumnInfo[]): Promise<void> {
    try {
      await this.start();
      this.currentTable = table;
      this.currentCols = columns;
      // IDENTITY_INSERT is set per insert batch (see insertChunk), not here: a
      // standalone `SET IDENTITY_INSERT ON` request doesn't carry over to a
      // later INSERT request on the same mssql Transaction.
    } catch (err) {
      await this.abort();
      throw err;
    }
  }

  async write(rows: Row[]): Promise<void> {
    const table = this.currentTable;
    if (!table) throw new Error("MssqlSink.write called before begin");
    const cols = this.currentCols;
    const perStatement = Math.max(
      1,
      Math.min(
        this.batchSize,
        MAX_VALUE_ROWS,
        Math.floor(MAX_BIND_PARAMS / Math.max(cols.length, 1)),
      ),
    );
    try {
      for (let start = 0; start < rows.length; start += perStatement) {
        await this.insertChunk(
          table,
          cols,
          rows.slice(start, start + perStatement),
        );
      }
    } catch (err) {
      await this.abort();
      throw err;
    }
  }

  private async insertChunk(
    table: TableInfo,
    cols: ColumnInfo[],
    rows: Row[],
  ): Promise<void> {
    if (rows.length === 0) return;
    const colList = cols.map((c) => IDENT(c.name)).join(", ");
    const params: unknown[] = [];
    const tuples = rows.map((row) => {
      const ph = cols.map((c) => {
        params.push(toParam(row[c.name], c));
        return `@p${params.length}`;
      });
      return `(${ph.join(", ")})`;
    });
    // Prefix `SET IDENTITY_INSERT ON` in the *same* batch as the INSERT so the
    // explicit identity values are accepted — it's scoped to this batch and
    // resets after, so there's no cross-table IDENTITY_INSERT conflict.
    const identityPrefix = hasIdentity(cols)
      ? `SET IDENTITY_INSERT ${tableRef(table)} ON; `
      : "";
    const sql =
      identityPrefix +
      `INSERT INTO ${tableRef(table)} (${colList}) VALUES ` +
      tuples.join(", ");
    await this.conn.query(sql, params);
    this.total += rows.length;
  }

  async end(): Promise<void> {
    if (this.currentTable) this.filled.push(this.currentTable);
    this.currentTable = null;
  }

  async finalize(): Promise<void> {
    try {
      // Reset identity seeds so future app inserts don't collide with our ids.
      for (const table of this.filled) {
        if (table.columns.some((c) => c.isIdentity)) {
          await this.conn.query(
            `DBCC CHECKIDENT ('${table.schema}.${table.name}', RESEED)`,
          );
        }
      }
      await this.conn.query("COMMIT");
    } catch (err) {
      await this.abort();
      throw err;
    }
  }

  private async abort(): Promise<void> {
    if (this.started) {
      try {
        await this.conn.query("ROLLBACK");
      } catch {
        // Connection may already be in a failed state; surface the original error.
      }
    }
  }
}

/** Insert already-materialized `TableData[]` (e.g. a subset) via batched INSERTs. */
export async function insertDataMssql(
  conn: Connection,
  data: TableData[],
  opts: { truncate?: boolean; batchSize?: number } = {},
): Promise<number> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const sink = new MssqlSink(
    conn,
    { truncate: opts.truncate, tables: data.map((d) => d.table) },
    batchSize,
  );
  for (const { table, rows, columns } of data) {
    await sink.begin(table, columns);
    await sink.write(rows);
    await sink.end();
  }
  await sink.finalize();
  return sink.inserted;
}
