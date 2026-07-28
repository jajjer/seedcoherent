/** Turns generated TableData into SQLite SQL text or streams it into a live DB. */

import { DEFAULT_BATCH_SIZE } from "./config.js";
import type { RowSink, Row, TableData } from "./generate.js";
import type { ColumnInfo, Connection, TableInfo } from "./types.js";

const JSON_TYPES = new Set(["json"]);

/** Double-quote a SQLite identifier, doubling any embedded quote. */
const IDENT = (s: string) => `"${s.replace(/"/g, '""')}"`;

/**
 * Writes use the *unqualified* table name so they land in the database file the
 * connection opened (SQLite's `main`). A `schema.table` prefix would target an
 * attached database, so — as with the MySQL sink — qualifying with the source
 * schema would wrongly write a `--to` target's rows back into the source.
 */
function tableRef(t: TableInfo): string {
  return IDENT(t.name);
}

/** Escape a SQLite string-literal body: only the single quote is special. */
function escapeString(s: string): string {
  return s.replace(/'/g, "''");
}

/** Format a JS value as a SQLite SQL literal (for --out/--print scripts). */
export function sqliteLiteral(v: unknown, col: ColumnInfo): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") return String(v);
  if (typeof v === "bigint") return String(v);
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (Buffer.isBuffer(v)) return `X'${v.toString("hex")}'`;
  if (Array.isArray(v) || JSON_TYPES.has(col.dataType) || typeof v === "object") {
    return `'${escapeString(JSON.stringify(v))}'`;
  }
  return `'${escapeString(String(v))}'`;
}

/**
 * Build a full, runnable SQLite script. FK enforcement is disabled for the load
 * (`PRAGMA foreign_keys=OFF`, which must sit outside the transaction) so the
 * script applies regardless of insert order.
 */
export function toSqlSqlite(data: TableData[]): string {
  const parts: string[] = ["PRAGMA foreign_keys=OFF;", "BEGIN TRANSACTION;", ""];

  for (const { table, rows, columns } of data) {
    if (rows.length === 0) continue;
    const colList = columns.map((c) => IDENT(c.name)).join(", ");
    parts.push(`-- ${table.key}: ${rows.length} rows`);
    parts.push(`INSERT INTO ${tableRef(table)} (${colList}) VALUES`);
    const values = rows.map((row) => {
      const tuple = columns.map((c) => sqliteLiteral(row[c.name], c)).join(", ");
      return `  (${tuple})`;
    });
    parts.push(values.join(",\n") + ";");
    parts.push("");
  }

  parts.push("COMMIT;");
  return parts.join("\n");
}

/**
 * Convert a JS value into a better-sqlite3 bind parameter. The driver accepts
 * only numbers, bigints, strings, Buffers, and null — so booleans become 1/0,
 * Dates become ISO strings, and objects/arrays (JSON columns) are serialized.
 */
export function toParam(v: unknown, col: ColumnInfo): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return v;
  if (Array.isArray(v) || JSON_TYPES.has(col.dataType) || typeof v === "object") {
    return JSON.stringify(v);
  }
  return v;
}

export interface CopyOptions {
  /** Empty the target tables (via DELETE, so it rolls back with the inserts). */
  truncate?: boolean;
  /** Tables that will be written, in dependency order (cleared in reverse). */
  tables?: TableInfo[];
}

/**
 * SQLite caps a single statement at 999 bound parameters by default (some older
 * builds), so we bound each multi-row INSERT to stay well under that regardless
 * of the caller's batch size.
 */
const MAX_BIND_PARAMS = 900;

/**
 * A {@link RowSink} that streams rows into SQLite as batched multi-row INSERTs
 * inside a single transaction. Rows are bound as `?` parameters (the driver
 * escapes them) and flushed in chunks small enough to respect SQLite's bound-
 * parameter limit. Explicit values are allowed into an INTEGER PRIMARY KEY and
 * SQLite advances its rowid counter on its own, so no sequence reset is needed.
 */
export class SqliteSink implements RowSink {
  private started = false;
  private currentTable: TableInfo | null = null;
  private currentCols: ColumnInfo[] = [];
  private total = 0;

  constructor(
    private readonly conn: Connection,
    private readonly opts: CopyOptions = {},
    private readonly batchSize: number = DEFAULT_BATCH_SIZE,
  ) {}

  /** Rows written so far. */
  get inserted(): number {
    return this.total;
  }

  private async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // Defer FK enforcement to COMMIT so any order / circular graph loads cleanly.
    await this.conn.query("PRAGMA defer_foreign_keys=ON");
    await this.conn.query("BEGIN");
    if (this.opts.truncate && this.opts.tables?.length) {
      for (const t of [...this.opts.tables].reverse()) {
        await this.conn.query(`DELETE FROM ${tableRef(t)}`);
      }
    }
  }

  async begin(table: TableInfo, columns: ColumnInfo[]): Promise<void> {
    try {
      await this.start();
      this.currentTable = table;
      this.currentCols = columns;
    } catch (err) {
      await this.abort();
      throw err;
    }
  }

  async write(rows: Row[]): Promise<void> {
    const table = this.currentTable;
    if (!table) throw new Error("SqliteSink.write called before begin");
    const cols = this.currentCols;
    // Rows per statement: honor batchSize but never exceed the bind-param cap.
    const perStatement = Math.max(1, Math.min(this.batchSize, Math.floor(MAX_BIND_PARAMS / Math.max(cols.length, 1))));
    try {
      for (let start = 0; start < rows.length; start += perStatement) {
        await this.insertChunk(table, cols, rows.slice(start, start + perStatement));
      }
    } catch (err) {
      await this.abort();
      throw err;
    }
  }

  private async insertChunk(table: TableInfo, cols: ColumnInfo[], rows: Row[]): Promise<void> {
    if (rows.length === 0) return;
    const colList = cols.map((c) => IDENT(c.name)).join(", ");
    const placeholder = `(${cols.map(() => "?").join(", ")})`;
    const params: unknown[] = [];
    for (const row of rows) {
      for (const c of cols) params.push(toParam(row[c.name], c));
    }
    const sql =
      `INSERT INTO ${tableRef(table)} (${colList}) VALUES ` + rows.map(() => placeholder).join(", ");
    await this.conn.query(sql, params);
    this.total += rows.length;
  }

  async end(): Promise<void> {
    this.currentTable = null;
  }

  async finalize(): Promise<void> {
    try {
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
export async function insertDataSqlite(
  conn: Connection,
  data: TableData[],
  opts: { truncate?: boolean; batchSize?: number } = {},
): Promise<number> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const sink = new SqliteSink(conn, { truncate: opts.truncate, tables: data.map((d) => d.table) }, batchSize);
  for (const { table, rows, columns } of data) {
    await sink.begin(table, columns);
    await sink.write(rows);
    await sink.end();
  }
  await sink.finalize();
  return sink.inserted;
}
