/** Turns generated TableData into MySQL SQL text or streams it into a live DB. */

import { DEFAULT_BATCH_SIZE } from "./config.js";
import type { RowSink, Row, TableData } from "./generate.js";
import type { ColumnInfo, Connection, TableInfo } from "./types.js";

const JSON_TYPES = new Set(["json"]);

/** Backtick-quote a MySQL identifier, doubling any embedded backtick. */
const IDENT = (s: string) => "`" + s.replace(/`/g, "``") + "`";

/**
 * Writes use the *unqualified* table name so they land in the database the
 * connection points at — a MySQL "schema" is a database, and a `db.table`
 * prefix is absolute, so qualifying with the source database would (wrongly)
 * write a `--to` target's rows back into the source. This mirrors how a
 * mysqldump of a single database omits the database prefix.
 */
function tableRef(t: TableInfo): string {
  return IDENT(t.name);
}

/** Escape a MySQL string-literal body: backslash *and* quote are special. */
function escapeString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "''");
}

/** MySQL DATETIME literal in UTC ('YYYY-MM-DD HH:MM:SS'), deterministic. */
function formatDate(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/** Format a JS value as a MySQL SQL literal (for --out/--print scripts). */
export function mysqlLiteral(v: unknown, col: ColumnInfo): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") return String(v);
  if (v instanceof Date) return `'${formatDate(v)}'`;
  if (Buffer.isBuffer(v)) return `X'${v.toString("hex")}'`;
  if (Array.isArray(v) || JSON_TYPES.has(col.dataType) || typeof v === "object") {
    return `'${escapeString(JSON.stringify(v))}'`;
  }
  return `'${escapeString(String(v))}'`;
}

/** Build a full, runnable MySQL script. FK checks are relaxed so any order loads. */
export function toSqlMysql(data: TableData[]): string {
  const parts: string[] = ["SET FOREIGN_KEY_CHECKS=0;", "START TRANSACTION;", ""];

  for (const { table, rows, columns } of data) {
    if (rows.length === 0) continue;
    const colList = columns.map((c) => IDENT(c.name)).join(", ");
    parts.push(`-- ${table.key}: ${rows.length} rows`);
    parts.push(`INSERT INTO ${tableRef(table)} (${colList}) VALUES`);
    const values = rows.map((row) => {
      const tuple = columns.map((c) => mysqlLiteral(row[c.name], c)).join(", ");
      return `  (${tuple})`;
    });
    parts.push(values.join(",\n") + ";");
    parts.push("");
  }

  parts.push("COMMIT;", "SET FOREIGN_KEY_CHECKS=1;");
  return parts.join("\n");
}

/**
 * Convert a JS value into a mysql2 bind parameter. Objects/arrays destined for
 * JSON columns must be serialized (mysql2 would otherwise stringify them as
 * `[object Object]`); booleans become 1/0; Dates and Buffers pass through, which
 * mysql2 renders as DATETIME literals and hex blobs respectively.
 */
export function toParam(v: unknown, col: ColumnInfo): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date || Buffer.isBuffer(v)) return v;
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
 * A {@link RowSink} that streams rows into MySQL as batched multi-row INSERTs
 * inside a single transaction. MySQL has no COPY, so rows are bound as `?`
 * parameters (mysql2 escapes them) and flushed `batchSize` at a time. Explicit
 * values are allowed into AUTO_INCREMENT columns and MySQL advances the counter
 * on its own, so no sequence reset is needed.
 */
export class MysqlSink implements RowSink {
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
    await this.conn.query("START TRANSACTION");
    if (this.opts.truncate && this.opts.tables?.length) {
      // FK checks off so tangled/circular graphs clear regardless of order.
      await this.conn.query("SET FOREIGN_KEY_CHECKS=0");
      for (const t of [...this.opts.tables].reverse()) {
        await this.conn.query(`DELETE FROM ${tableRef(t)}`);
      }
      await this.conn.query("SET FOREIGN_KEY_CHECKS=1");
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
    if (!table) throw new Error("MysqlSink.write called before begin");
    const cols = this.currentCols;
    try {
      for (let start = 0; start < rows.length; start += this.batchSize) {
        const chunk = rows.slice(start, start + this.batchSize);
        await this.insertChunk(table, cols, chunk);
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
      `INSERT INTO ${tableRef(table)} (${colList}) VALUES ` +
      rows.map(() => placeholder).join(", ");
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
export async function insertDataMysql(
  conn: Connection,
  data: TableData[],
  opts: { truncate?: boolean; batchSize?: number } = {},
): Promise<number> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const sink = new MysqlSink(conn, { truncate: opts.truncate, tables: data.map((d) => d.table) }, batchSize);
  for (const { table, rows, columns } of data) {
    await sink.begin(table, columns);
    await sink.write(rows);
    await sink.end();
  }
  await sink.finalize();
  return sink.inserted;
}
