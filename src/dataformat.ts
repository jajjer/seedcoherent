/**
 * Serializes generated {@link TableData} into CSV or NDJSON — data-only, plain
 * files with no SQL and no database. Unlike the SQL emitters these are entirely
 * dialect-independent: the same rows become the same CSV/NDJSON whether they
 * came from a Postgres, MySQL, or SQLite schema. Each table becomes its own file
 * (`<table>.csv` / `<table>.ndjson`) since CSV is inherently single-table.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Row, TableData } from "./generate.js";
import type { OutputFormat, TableInfo } from "./types.js";

export const OUTPUT_FORMATS: OutputFormat[] = ["sql", "csv", "ndjson"];

/** Narrow a raw string to a known output format. */
export function isOutputFormat(v: string): v is OutputFormat {
  return (OUTPUT_FORMATS as string[]).includes(v);
}

/**
 * JSON replacer that rescues the two JS values `JSON.stringify` handles wrongly
 * for our purposes, at any nesting depth: a `Buffer` (its default `toJSON` emits
 * `{type:"Buffer",data:[…]}`) becomes base64, and a `Date` becomes its ISO
 * string. `this[key]` is the pre-`toJSON` value, so we can spot a Buffer before
 * its `toJSON` fires; a Date's own `toJSON` already gives the ISO string we want.
 */
function jsonReplacer(this: Record<string, unknown>, key: string, value: unknown): unknown {
  const raw = this[key];
  if (Buffer.isBuffer(raw)) return raw.toString("base64");
  return value;
}

/** Encode one row as a JSON object over the emitted columns, in column order. */
function ndjsonRow(row: Row, columns: TableData["columns"]): string {
  const obj: Record<string, unknown> = {};
  for (const c of columns) {
    const v = row[c.name];
    obj[c.name] = v === undefined ? null : v;
  }
  return JSON.stringify(obj, jsonReplacer);
}

/** Serialize a table to newline-delimited JSON (one object per row). */
export function tableToNdjson(td: TableData): string {
  if (td.rows.length === 0) return "";
  return td.rows.map((r) => ndjsonRow(r, td.columns)).join("\n") + "\n";
}

/**
 * Render a single value as CSV field text (before quoting). Nulls are empty,
 * dates are ISO, binary is base64, and arrays/objects (including json columns)
 * are compact JSON. Numbers/booleans/strings are their plain text.
 */
function csvField(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return v.toString("base64");
  return JSON.stringify(v, jsonReplacer);
}

/** RFC 4180 quoting: wrap in double quotes (doubling any inside) when needed. */
function csvQuote(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Serialize a table to CSV: a header row of column names followed by one row per
 * record, LF-terminated. The header is always present, so an empty table yields
 * a header-only file that still documents its shape.
 */
export function tableToCsv(td: TableData): string {
  const lines = [td.columns.map((c) => csvQuote(c.name)).join(",")];
  for (const row of td.rows) {
    lines.push(td.columns.map((c) => csvQuote(csvField(row[c.name]))).join(","));
  }
  return lines.join("\n") + "\n";
}

/** Strip path separators/NUL so a table name is safe as a single filename. */
function sanitizeFileName(name: string): string {
  return name.replace(/[/\\\x00]/g, "_");
}

/**
 * File base name per table: the bare table name, qualified with its schema
 * (`schema.name`) only when a bare name would collide across schemas.
 */
function fileBaseNames(data: TableData[]): Map<TableInfo, string> {
  const counts = new Map<string, number>();
  for (const d of data) counts.set(d.table.name, (counts.get(d.table.name) ?? 0) + 1);
  const out = new Map<TableInfo, string>();
  for (const d of data) {
    const base = (counts.get(d.table.name) ?? 0) > 1 ? d.table.key : d.table.name;
    out.set(d.table, sanitizeFileName(base));
  }
  return out;
}

/**
 * Write each table to its own file in `dir` (created if missing). Empty tables
 * are skipped, matching the SQL emitter's "no INSERT for zero rows". Returns the
 * total rows written and how many files that spanned.
 */
export async function writeTableFiles(
  data: TableData[],
  dir: string,
  format: "csv" | "ndjson",
): Promise<{ rows: number; files: number }> {
  await mkdir(dir, { recursive: true });
  const names = fileBaseNames(data);
  let rows = 0;
  let files = 0;
  for (const td of data) {
    if (td.rows.length === 0) continue;
    const text = format === "csv" ? tableToCsv(td) : tableToNdjson(td);
    await writeFile(join(dir, `${names.get(td.table)!}.${format}`), text, "utf8");
    rows += td.rows.length;
    files++;
  }
  return { rows, files };
}
