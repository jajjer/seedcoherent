/** Live-SQL Server implementation of the subset RowFetcher (`@pN` placeholders). */

import type { Row } from "./generate.js";
import { sampleOrder, toInt, type RowFetcher } from "./subset.js";
import type { Connection, TableInfo } from "./types.js";

// SQL Server caps a request at 2100 parameters; keep chunks well under that even
// for composite keys (params = columns * chunk).
const KEY_CHUNK = 500;

const ident = (s: string) => `[${s.replace(/\]/g, "]]")}]`;
const qual = (t: TableInfo) => `${ident(t.schema)}.${ident(t.name)}`;

export class MssqlRowFetcher implements RowFetcher {
  constructor(private conn: Connection) {}

  async fetchRoots(
    table: TableInfo,
    limit: number,
    where?: string,
    sample?: boolean,
    seed?: number,
  ): Promise<Row[]> {
    // SQL Server has no LIMIT — TOP (n) does the job (needs an ORDER BY to be
    // deterministic, which the primary key provides when present). With
    // --sample, ORDER BY NEWID() shuffles instead, so TOP (n) is a random draw;
    // with --seed, a HASHBYTES of (seed ‖ PK) makes that draw reproducible.
    const filter = where ? ` WHERE ${where}` : "";
    const params: unknown[] = [limit];
    let order = "";
    switch (sampleOrder(table, !!sample, seed)) {
      case "pk":
        order = ` ORDER BY ${table.primaryKey.map(ident).join(", ")}`;
        break;
      case "random":
        order = " ORDER BY NEWID()";
        break;
      case "seeded":
        params.push(String(seed));
        order = ` ORDER BY HASHBYTES('MD5', CONCAT_WS('|', @p${
          params.length
        }, ${table.primaryKey.map(ident).join(", ")}))`;
        break;
    }
    const res = await this.conn.query<Row>(
      `SELECT TOP (@p1) * FROM ${qual(table)}${filter}${order}`,
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
      const params: unknown[] = [];
      let where: string;
      if (columns.length === 1) {
        const ph = chunk.map((k) => {
          params.push(k[0]);
          return `@p${params.length}`;
        });
        where = `${ident(columns[0])} IN (${ph.join(", ")})`;
      } else {
        // No tuple-IN in SQL Server; OR together one AND-group per key tuple.
        const groups = chunk.map((tuple) => {
          const preds = tuple.map((v, j) => {
            params.push(v);
            return `${ident(columns[j])} = @p${params.length}`;
          });
          return `(${preds.join(" AND ")})`;
        });
        where = groups.join(" OR ");
      }
      const res = await this.conn.query<Row>(
        `SELECT * FROM ${qual(table)} WHERE ${where}`,
        params,
      );
      rows.push(...res.rows);
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
