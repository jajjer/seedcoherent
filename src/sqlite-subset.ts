/** Live-SQLite implementation of the subset RowFetcher (`?` placeholders). */

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { Row } from "./generate.js";
import { sampleOrder, toInt, type RowFetcher } from "./subset.js";
import type { Connection, TableInfo } from "./types.js";

const KEY_CHUNK = 500;

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
// Unqualified: reads come from the connection's main database, like the sink writes.
const ref = (t: TableInfo) => ident(t.name);

/** The SQLite Connection carries its raw better-sqlite3 handle for UDF registration. */
interface SqliteConn extends Connection {
  db: Database.Database;
}

export class SqliteRowFetcher implements RowFetcher {
  private seedFnReady = false;

  constructor(private conn: Connection) {}

  /**
   * SQLite's RANDOM() takes no seed, so reproducible sampling needs a
   * deterministic ORDER BY. Register a `seedhash(...)` UDF (md5 of its
   * '|'-joined args) on the raw handle once; `ORDER BY seedhash(seed, pk…)`
   * then draws the same rows for a given seed.
   */
  private ensureSeedFn(): void {
    if (this.seedFnReady) return;
    (this.conn as SqliteConn).db.function(
      "seedhash",
      { deterministic: true, varargs: true },
      (...vals: unknown[]) =>
        createHash("md5")
          .update(vals.map((v) => String(v)).join("|"))
          .digest("hex"),
    );
    this.seedFnReady = true;
  }

  async fetchRoots(
    table: TableInfo,
    limit: number,
    where?: string,
    sample?: boolean,
    seed?: number,
  ): Promise<Row[]> {
    const filter = where ? ` WHERE ${where}` : "";
    const params: unknown[] = [];
    let order = "";
    switch (sampleOrder(table, !!sample, seed)) {
      case "pk":
        order = ` ORDER BY ${table.primaryKey.map(ident).join(", ")}`;
        break;
      case "random":
        order = " ORDER BY RANDOM()";
        break;
      case "seeded":
        this.ensureSeedFn();
        params.push(String(seed));
        order = ` ORDER BY seedhash(?, ${table.primaryKey
          .map(ident)
          .join(", ")})`;
        break;
    }
    params.push(limit);
    const res = await this.conn.query<Row>(
      `SELECT * FROM ${ref(table)}${filter}${order} LIMIT ?`,
      params,
    );
    return res.rows;
  }

  async countRows(table: TableInfo, where?: string): Promise<number> {
    const filter = where ? ` WHERE ${where}` : "";
    const res = await this.conn.query<Row>(
      `SELECT COUNT(*) AS c FROM ${ref(table)}${filter}`,
    );
    return toInt(res.rows[0]?.c) ?? 0;
  }

  async fetchByKeys(
    table: TableInfo,
    columns: string[],
    keys: unknown[][],
  ): Promise<Row[]> {
    if (keys.length === 0) return [];
    const rows: Row[] = [];
    for (let i = 0; i < keys.length; i += KEY_CHUNK) {
      const chunk = keys.slice(i, i + KEY_CHUNK);
      if (columns.length === 1) {
        const placeholders = chunk.map(() => "?").join(", ");
        const res = await this.conn.query<Row>(
          `SELECT * FROM ${ref(table)} WHERE ${ident(columns[0])} IN (${placeholders})`,
          chunk.map((k) => k[0]),
        );
        rows.push(...res.rows);
      } else {
        // SQLite supports row-value IN lists: `(a, b) IN ((?, ?), (?, ?))`.
        const params: unknown[] = [];
        const tuples = chunk.map((tuple) => {
          const ph = tuple.map((v) => {
            params.push(v);
            return "?";
          });
          return `(${ph.join(", ")})`;
        });
        const colList = columns.map(ident).join(", ");
        const res = await this.conn.query<Row>(
          `SELECT * FROM ${ref(table)} WHERE (${colList}) IN (${tuples.join(", ")})`,
          params,
        );
        rows.push(...res.rows);
      }
    }
    return rows;
  }

  async maxInt(table: TableInfo, column: string): Promise<number | null> {
    const res = await this.conn.query<Row>(
      `SELECT MAX(${ident(column)}) AS m FROM ${ref(table)}`,
    );
    return toInt(res.rows[0]?.m);
  }
}
