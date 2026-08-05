/** Turns generated TableData into SQL text or executes it against a live DB. */

import { once } from "node:events";
import { finished } from "node:stream/promises";
import type { Writable } from "node:stream";
import type { Client } from "pg";
import copyStreams from "pg-copy-streams";
import { DEFAULT_BATCH_SIZE } from "./config.js";
import type { RowSink, Row, TableData } from "./generate.js";
import type { ColumnInfo, TableInfo } from "./types.js";

const { from: copyFrom } = copyStreams;

const JSON_TYPES = new Set(["json"]);
const IDENT = (s: string) => `"${s.replace(/"/g, '""')}"`;

function qualified(t: TableInfo): string {
  return `${IDENT(t.schema)}.${IDENT(t.name)}`;
}

/**
 * Do we insert an explicit value into an identity column? If so the INSERT needs
 * OVERRIDING SYSTEM VALUE (required for GENERATED ALWAYS, harmless otherwise).
 * This covers composite-PK and non-PK identity columns, not just single-int PKs.
 */
function overridesIdentity(columns: ColumnInfo[]): boolean {
  return columns.some((c) => c.isIdentity);
}

/** Format a JS value as a Postgres SQL literal. */
export function sqlLiteral(v: unknown, col: ColumnInfo): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return String(v);
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (Buffer.isBuffer(v)) return `'\\x${v.toString("hex")}'`;
  // A json/jsonb column encodes the whole value as JSON — including a JS array,
  // which is a JSON array `[...]`, not a Postgres array `{...}`. Check this before
  // the array branch so json arrays don't get the wrong literal form.
  if (JSON_TYPES.has(col.dataType)) {
    return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  }
  if (Array.isArray(v)) {
    const inner = v.map((el) => `"${String(el).replace(/["\\]/g, "\\$&")}"`).join(",");
    return `'{${inner}}'`;
  }
  if (typeof v === "object") {
    return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** Build a full, runnable SQL script (wrapped in a transaction). */
export function toSql(data: TableData[]): string {
  const parts: string[] = ["BEGIN;", ""];

  for (const { table, rows, columns } of data) {
    if (rows.length === 0) continue;
    const colList = columns.map((c) => IDENT(c.name)).join(", ");
    const override = overridesIdentity(columns) ? " OVERRIDING SYSTEM VALUE" : "";
    parts.push(`-- ${table.key}: ${rows.length} rows`);
    parts.push(`INSERT INTO ${qualified(table)} (${colList})${override} VALUES`);
    const values = rows.map((row) => {
      const tuple = columns.map((c) => sqlLiteral(row[c.name], c)).join(", ");
      return `  (${tuple})`;
    });
    parts.push(values.join(",\n") + ";");
    parts.push("");
  }

  parts.push(...resetSequences(data));
  parts.push("COMMIT;");
  return parts.join("\n");
}

/**
 * setval() statement so a table's serial/identity sequence doesn't collide with
 * the explicit ids we inserted. Returns null when the table has no such PK.
 */
function sequenceResetSql(table: TableInfo): string | null {
  if (table.primaryKey.length !== 1) return null;
  const pk = table.columns.find((c) => c.name === table.primaryKey[0]);
  if (!pk || pk.dataType !== "integer" || !(pk.isIdentity || pk.hasDefault)) return null;
  return (
    `SELECT setval(pg_get_serial_sequence('${table.schema}.${table.name}', '${pk.name}'), ` +
    `(SELECT COALESCE(MAX(${IDENT(pk.name)}), 1) FROM ${qualified(table)}), true);`
  );
}

/** setval() statements so serial/identity sequences don't collide with our explicit ids. */
function resetSequences(data: TableData[]): string[] {
  const out: string[] = [];
  for (const { table, rows } of data) {
    if (rows.length === 0) continue;
    const sql = sequenceResetSql(table);
    if (sql) out.push(sql);
  }
  if (out.length) out.unshift("", "-- reset sequences");
  return out;
}

/**
 * Format a JS value for a COPY ... FROM STDIN row in the default *text* format.
 * Rules differ from `sqlLiteral`: NULL is `\N`, fields are tab/newline-escaped,
 * booleans are `t`/`f`, and backslash-bearing forms (bytea `\x…`, array/JSON
 * literals) get their backslashes doubled so Postgres' COPY parser un-escapes
 * them back to the intended value.
 */
export function copyValue(v: unknown, col: ColumnInfo): string {
  if (v === null || v === undefined) return "\\N";
  if (typeof v === "boolean") return v ? "t" : "f";
  if (typeof v === "number") return String(v);
  if (v instanceof Date) return copyEscape(v.toISOString());
  if (Buffer.isBuffer(v)) return copyEscape(`\\x${v.toString("hex")}`);
  // A json/jsonb column encodes as JSON first, so an array becomes `[...]` not
  // the Postgres array `{...}` the next branch would produce.
  if (JSON_TYPES.has(col.dataType)) return copyEscape(JSON.stringify(v));
  if (Array.isArray(v)) return copyEscape(pgArrayLiteral(v));
  if (typeof v === "object") return copyEscape(JSON.stringify(v));
  return copyEscape(String(v));
}

/** Escape a text-format COPY field: backslash first, then the control chars. */
function copyEscape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/** Build a Postgres array literal `{"a","b"}` (same quoting as sqlLiteral). */
function pgArrayLiteral(v: unknown[]): string {
  const inner = v.map((el) => `"${String(el).replace(/["\\]/g, "\\$&")}"`).join(",");
  return `{${inner}}`;
}

/** Encode one row as a tab-separated, newline-terminated COPY text line. */
function copyRow(row: Row, columns: ColumnInfo[]): string {
  return columns.map((c) => copyValue(row[c.name], c)).join("\t") + "\n";
}

export interface CopyOptions {
  /** TRUNCATE ... RESTART IDENTITY CASCADE the target tables first. */
  truncate?: boolean;
  /** Tables that will be written, in dependency order (truncated in reverse). */
  tables?: TableInfo[];
}

/**
 * A {@link RowSink} that streams rows into Postgres with COPY ... FROM STDIN,
 * inside a single transaction. Far faster and lower-memory than multi-row
 * INSERTs. Unlike INSERT, COPY writes explicit values straight into identity
 * columns, so no `OVERRIDING SYSTEM VALUE` is needed; sequences are reset in
 * `finalize` so later app inserts don't collide.
 */
export class CopySink implements RowSink {
  private started = false;
  private stream: Writable | null = null;
  private currentTable: TableInfo | null = null;
  private currentCols: ColumnInfo[] = [];
  private currentCount = 0;
  /** Tables that actually received rows, for sequence resets. */
  private readonly filled: TableInfo[] = [];
  private total = 0;

  constructor(
    private readonly client: Client,
    private readonly opts: CopyOptions = {},
  ) {}

  /** Rows written so far. */
  get inserted(): number {
    return this.total;
  }

  private async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.client.query("BEGIN");
    if (this.opts.truncate && this.opts.tables?.length) {
      const list = this.opts.tables.map((t) => qualified(t)).reverse();
      await this.client.query(`TRUNCATE ${list.join(", ")} RESTART IDENTITY CASCADE`);
    }
  }

  async begin(table: TableInfo, columns: ColumnInfo[]): Promise<void> {
    try {
      await this.start();
      this.currentTable = table;
      this.currentCols = columns;
      this.currentCount = 0;
      const colList = columns.map((c) => IDENT(c.name)).join(", ");
      this.stream = this.client.query(
        copyFrom(`COPY ${qualified(table)} (${colList}) FROM STDIN`),
      ) as unknown as Writable;
    } catch (err) {
      await this.abort();
      throw err;
    }
  }

  async write(rows: Row[]): Promise<void> {
    const stream = this.stream;
    if (!stream) throw new Error("CopySink.write called before begin");
    try {
      let chunk = "";
      for (const row of rows) chunk += copyRow(row, this.currentCols);
      if (!stream.write(chunk)) await once(stream, "drain");
      this.currentCount += rows.length;
      this.total += rows.length;
    } catch (err) {
      await this.abort();
      throw err;
    }
  }

  async end(): Promise<void> {
    const stream = this.stream;
    if (!stream) return;
    try {
      stream.end();
      await finished(stream);
      if (this.currentCount > 0 && this.currentTable) this.filled.push(this.currentTable);
      this.stream = null;
      this.currentTable = null;
    } catch (err) {
      await this.abort();
      throw err;
    }
  }

  async finalize(): Promise<void> {
    try {
      // Reset sequences so future app inserts don't collide with our explicit ids.
      for (const table of this.filled) {
        const sql = sequenceResetSql(table);
        if (sql) await this.client.query(sql);
      }
      await this.client.query("COMMIT");
    } catch (err) {
      await this.abort();
      throw err;
    }
  }

  private async abort(): Promise<void> {
    this.stream?.destroy();
    this.stream = null;
    if (this.started) {
      try {
        await this.client.query("ROLLBACK");
      } catch {
        // The connection may already be in a failed state; surface the original.
      }
    }
  }
}

/**
 * Insert already-materialized `TableData[]` (e.g. a subset) via the streaming
 * COPY path, chunked into `batchSize` rows.
 */
export async function insertData(
  client: Client,
  data: TableData[],
  opts: { truncate?: boolean; batchSize?: number } = {},
): Promise<number> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const sink = new CopySink(client, {
    truncate: opts.truncate,
    tables: data.map((d) => d.table),
  });
  for (const { table, rows, columns } of data) {
    await sink.begin(table, columns);
    for (let start = 0; start < rows.length; start += batchSize) {
      await sink.write(rows.slice(start, start + batchSize));
    }
    await sink.end();
  }
  await sink.finalize();
  return sink.inserted;
}

/** Execute the generated rows against a live connection, inside one transaction. */
export async function insertInto(
  client: Client,
  data: TableData[],
  truncate = false,
): Promise<number> {
  return insertData(client, data, { truncate });
}
