/** Live-SQLite implementation of the subset RowFetcher (`?` placeholders). */

import type { Row } from "./generate.js";
import { toInt, type RowFetcher } from "./subset.js";
import type { Connection, TableInfo } from "./types.js";

const KEY_CHUNK = 500;

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
// Unqualified: reads come from the connection's main database, like the sink writes.
const ref = (t: TableInfo) => ident(t.name);

export class SqliteRowFetcher implements RowFetcher {
  constructor(private conn: Connection) {}

  async fetchRoots(table: TableInfo, limit: number): Promise<Row[]> {
    const order = table.primaryKey.length
      ? ` ORDER BY ${table.primaryKey.map(ident).join(", ")}`
      : "";
    const res = await this.conn.query<Row>(`SELECT * FROM ${ref(table)}${order} LIMIT ?`, [limit]);
    return res.rows;
  }

  async fetchByKeys(table: TableInfo, columns: string[], keys: unknown[][]): Promise<Row[]> {
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
    const res = await this.conn.query<Row>(`SELECT MAX(${ident(column)}) AS m FROM ${ref(table)}`);
    return toInt(res.rows[0]?.m);
  }
}
