/** Turns generated TableData into SQL text or executes it against a live DB. */

import type { Client } from "pg";
import type { TableData } from "./generate.js";
import type { ColumnInfo, TableInfo } from "./types.js";

const JSON_TYPES = new Set(["json"]);
const IDENT = (s: string) => `"${s.replace(/"/g, '""')}"`;

function qualified(t: TableInfo): string {
  return `${IDENT(t.schema)}.${IDENT(t.name)}`;
}

/** Does the table use an identity PK we assign explicit values for? */
function overridesIdentity(t: TableInfo): boolean {
  if (t.primaryKey.length !== 1) return false;
  const col = t.columns.find((c) => c.name === t.primaryKey[0]);
  return !!col && col.isIdentity && col.dataType === "integer";
}

/** Format a JS value as a Postgres SQL literal. */
export function sqlLiteral(v: unknown, col: ColumnInfo): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return String(v);
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (Buffer.isBuffer(v)) return `'\\x${v.toString("hex")}'`;
  if (Array.isArray(v)) {
    const inner = v.map((el) => `"${String(el).replace(/["\\]/g, "\\$&")}"`).join(",");
    return `'{${inner}}'`;
  }
  if (JSON_TYPES.has(col.dataType) || typeof v === "object") {
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
    const override = overridesIdentity(table) ? " OVERRIDING SYSTEM VALUE" : "";
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

/** setval() statements so serial/identity sequences don't collide with our explicit ids. */
function resetSequences(data: TableData[]): string[] {
  const out: string[] = [];
  for (const { table, rows } of data) {
    if (rows.length === 0 || table.primaryKey.length !== 1) continue;
    const pk = table.columns.find((c) => c.name === table.primaryKey[0]);
    if (!pk || pk.dataType !== "integer" || !(pk.isIdentity || pk.hasDefault)) continue;
    out.push(
      `SELECT setval(pg_get_serial_sequence('${table.schema}.${table.name}', '${pk.name}'), ` +
        `(SELECT COALESCE(MAX(${IDENT(pk.name)}), 1) FROM ${qualified(table)}), true);`,
    );
  }
  if (out.length) out.unshift("", "-- reset sequences");
  return out;
}

/** Execute the generated rows against a live connection, inside one transaction. */
export async function insertInto(
  client: Client,
  data: TableData[],
  truncate = false,
): Promise<number> {
  let total = 0;
  await client.query("BEGIN");
  try {
    if (truncate) {
      const tables = data
        .filter((d) => d.rows.length > 0)
        .map((d) => qualified(d.table))
        .reverse();
      if (tables.length) {
        await client.query(`TRUNCATE ${tables.join(", ")} RESTART IDENTITY CASCADE`);
      }
    }

    for (const { table, rows, columns } of data) {
      if (rows.length === 0) continue;
      const colList = columns.map((c) => IDENT(c.name)).join(", ");
      const override = overridesIdentity(table) ? " OVERRIDING SYSTEM VALUE" : "";

      // Batch to keep parameter count under Postgres' 65535 limit.
      const perRow = columns.length;
      const maxRows = Math.max(1, Math.floor(60000 / perRow));
      for (let start = 0; start < rows.length; start += maxRows) {
        const batch = rows.slice(start, start + maxRows);
        const params: unknown[] = [];
        const tuples = batch.map((row) => {
          const placeholders = columns.map((c) => {
            params.push(prepareParam(row[c.name], c));
            return `$${params.length}`;
          });
          return `(${placeholders.join(", ")})`;
        });
        await client.query(
          `INSERT INTO ${qualified(table)} (${colList})${override} VALUES ${tuples.join(", ")}`,
          params,
        );
        total += batch.length;
      }
    }

    // Reset sequences so future app inserts don't collide with our explicit ids.
    for (const line of resetSequences(data)) {
      if (line.startsWith("SELECT")) await client.query(line);
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
  return total;
}

function prepareParam(v: unknown, col: ColumnInfo): unknown {
  if (v !== null && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v) && !Buffer.isBuffer(v)) {
    return JSON.stringify(v);
  }
  return v;
}
