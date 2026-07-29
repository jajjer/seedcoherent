/** Live-MySQL implementation of the subset RowFetcher (`?` placeholders). */

import type { Row } from "./generate.js";
import { toInt, type RowFetcher } from "./subset.js";
import type { Connection, TableInfo } from "./types.js";

const KEY_CHUNK = 1000;

const ident = (s: string) => "`" + s.replace(/`/g, "``") + "`";
const qual = (t: TableInfo) => `${ident(t.schema)}.${ident(t.name)}`;

export class MysqlRowFetcher implements RowFetcher {
  constructor(private conn: Connection) {}

  async fetchRoots(table: TableInfo, limit: number): Promise<Row[]> {
    const order = table.primaryKey.length
      ? ` ORDER BY ${table.primaryKey.map(ident).join(", ")}`
      : "";
    const res = await this.conn.query<Row>(`SELECT * FROM ${qual(table)}${order} LIMIT ?`, [limit]);
    return res.rows;
  }

  async fetchByKeys(table: TableInfo, columns: string[], keys: unknown[][]): Promise<Row[]> {
    if (keys.length === 0) return [];
    const rows: Row[] = [];
    for (let i = 0; i < keys.length; i += KEY_CHUNK) {
      const chunk = keys.slice(i, i + KEY_CHUNK);
      if (columns.length === 1) {
        // Single-column FK: mysql2 expands an array bound into `IN (a, b, c)`.
        const res = await this.conn.query<Row>(
          `SELECT * FROM ${qual(table)} WHERE ${ident(columns[0])} IN (?)`,
          [chunk.map((k) => k[0])],
        );
        rows.push(...res.rows);
      } else {
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
          `SELECT * FROM ${qual(table)} WHERE (${colList}) IN (${tuples.join(", ")})`,
          params,
        );
        rows.push(...res.rows);
      }
    }
    return rows;
  }

  async maxInt(table: TableInfo, column: string): Promise<number | null> {
    const res = await this.conn.query<Row>(`SELECT MAX(${ident(column)}) AS m FROM ${qual(table)}`);
    return toInt(res.rows[0]?.m);
  }
}
