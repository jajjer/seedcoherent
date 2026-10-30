/** Live-MySQL implementation of the subset RowFetcher (`?` placeholders). */

import type { Row } from "./generate.js";
import { sampleOrder, toInt, type RowFetcher } from "./subset.js";
import type { Connection, TableInfo } from "./types.js";

const KEY_CHUNK = 1000;

const ident = (s: string) => "`" + s.replace(/`/g, "``") + "`";
const qual = (t: TableInfo) => `${ident(t.schema)}.${ident(t.name)}`;

export class MysqlRowFetcher implements RowFetcher {
  constructor(private conn: Connection) {}

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
        order = " ORDER BY RAND()";
        break;
      case "seeded":
        params.push(String(seed));
        order = ` ORDER BY MD5(CONCAT_WS('|', ?, ${table.primaryKey
          .map(ident)
          .join(", ")}))`;
        break;
    }
    params.push(limit);
    const res = await this.conn.query<Row>(
      `SELECT * FROM ${qual(table)}${filter}${order} LIMIT ?`,
      params,
    );
    return res.rows;
  }

  async countRows(table: TableInfo, where?: string): Promise<number> {
    const filter = where ? ` WHERE ${where}` : "";
    const res = await this.conn.query<Row>(
      `SELECT COUNT(*) AS c FROM ${qual(table)}${filter}`,
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
    const res = await this.conn.query<Row>(
      `SELECT MAX(${ident(column)}) AS m FROM ${qual(table)}`,
    );
    return toInt(res.rows[0]?.m);
  }
}
