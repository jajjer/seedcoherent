/**
 * Dialect seam: picks the Postgres, MySQL, or SQLite implementation from a
 * connection string and exposes a uniform surface (connect, introspect, subset
 * fetcher, bulk-insert sink, offline script) so the CLI stays database-agnostic.
 */

import pg from "pg";
import mysql from "mysql2/promise";
import Database from "better-sqlite3";
import { CopySink, insertData as insertDataPg, toSql } from "./emit.js";
import type { RowSink, TableData } from "./generate.js";
import { introspect } from "./introspect.js";
import { insertDataMysql, MysqlSink, toSqlMysql } from "./mysql-emit.js";
import { introspectMysql } from "./mysql-introspect.js";
import { MysqlRowFetcher } from "./mysql-subset.js";
import { insertDataSqlite, SqliteSink, toSqlSqlite } from "./sqlite-emit.js";
import { introspectSqlite } from "./sqlite-introspect.js";
import { SqliteRowFetcher } from "./sqlite-subset.js";
import { PgRowFetcher, type RowFetcher } from "./subset.js";
import type { Connection, Schema, TableInfo } from "./types.js";

export type DialectName = "postgres" | "mysql" | "sqlite";

export interface SinkOptions {
  truncate?: boolean;
  tables?: TableInfo[];
  batchSize?: number;
}

/** A bulk-insert sink that also reports how many rows it has written. */
export interface SinkHandle extends RowSink {
  readonly inserted: number;
}

export interface Dialect {
  readonly name: DialectName;
  connect(connStr: string): Promise<Connection>;
  /** Schema(s) to read when the user passes no --schema. */
  defaultSchemas(connStr: string): string[];
  introspect(conn: Connection, schemas: string[]): Promise<Schema>;
  createRowFetcher(conn: Connection): RowFetcher;
  createSink(conn: Connection, opts: SinkOptions): SinkHandle;
  /** Insert already-materialized data (subset path) and return the row count. */
  insertData(conn: Connection, data: TableData[], opts: SinkOptions): Promise<number>;
  toScript(data: TableData[]): string;
}

/** Wraps a `pg.Client` as a driver-neutral Connection, keeping the raw client for COPY. */
class PgConnection implements Connection {
  constructor(readonly client: pg.Client) {}
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
    return this.client.query<any>(sql, params as any);
  }
  end(): Promise<void> {
    return this.client.end();
  }
}

const postgresDialect: Dialect = {
  name: "postgres",
  async connect(connStr) {
    const client = new pg.Client({ connectionString: connStr });
    await client.connect();
    return new PgConnection(client);
  },
  defaultSchemas() {
    return ["public"];
  },
  introspect(conn, schemas) {
    return introspect(conn, schemas);
  },
  createRowFetcher(conn) {
    return new PgRowFetcher(conn);
  },
  createSink(conn, opts) {
    return new CopySink((conn as PgConnection).client, { truncate: opts.truncate, tables: opts.tables });
  },
  insertData(conn, data, opts) {
    return insertDataPg((conn as PgConnection).client, data, {
      truncate: opts.truncate,
      batchSize: opts.batchSize,
    });
  },
  toScript(data) {
    return toSql(data);
  },
};

/** Wraps a `mysql2` connection as a driver-neutral Connection. */
class MyConnection implements Connection {
  constructor(private conn: mysql.Connection) {}
  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
    const [rows] = await this.conn.query(sql, params);
    return { rows: rows as unknown as T[] };
  }
  end(): Promise<void> {
    return this.conn.end();
  }
}

const mysqlDialect: Dialect = {
  name: "mysql",
  async connect(connStr) {
    return new MyConnection(await mysql.createConnection(connStr));
  },
  defaultSchemas(connStr) {
    try {
      const db = decodeURIComponent(new URL(connStr).pathname.replace(/^\//, ""));
      return db ? [db] : [];
    } catch {
      return [];
    }
  },
  introspect(conn, schemas) {
    return introspectMysql(conn, schemas);
  },
  createRowFetcher(conn) {
    return new MysqlRowFetcher(conn);
  },
  createSink(conn, opts) {
    return new MysqlSink(conn, { truncate: opts.truncate, tables: opts.tables }, opts.batchSize);
  },
  insertData(conn, data, opts) {
    return insertDataMysql(conn, data, { truncate: opts.truncate, batchSize: opts.batchSize });
  },
  toScript(data) {
    return toSqlMysql(data);
  },
};

/**
 * Wraps a synchronous better-sqlite3 handle behind the async Connection surface.
 * SQLite has no schemas in the Postgres sense — a file is one database, exposed
 * as `main` — so PRAGMAs/reads target the connection's own database.
 */
class SqliteConnection implements Connection {
  constructor(readonly db: Database.Database) {}
  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
    const stmt = this.db.prepare(sql);
    const args = (params ?? []) as unknown[];
    // `reader` is true for statements that return rows (SELECT and most PRAGMAs).
    if (stmt.reader) return { rows: stmt.all(...args) as T[] };
    stmt.run(...args);
    return { rows: [] };
  }
  async end(): Promise<void> {
    this.db.close();
  }
}

/**
 * Resolve a SQLite connection string to a filename better-sqlite3 can open:
 * strips a `sqlite:`/`file:` scheme (`sqlite::memory:` -> `:memory:`,
 * `sqlite://./app.db` -> `./app.db`), and passes a bare path through untouched.
 */
export function sqliteFile(connStr: string): string {
  const m = connStr.match(/^(?:sqlite|file):(.*)$/i);
  if (!m) return connStr;
  return m[1].replace(/^\/\//, "");
}

const sqliteDialect: Dialect = {
  name: "sqlite",
  async connect(connStr) {
    return new SqliteConnection(new Database(sqliteFile(connStr)));
  },
  defaultSchemas() {
    return ["main"];
  },
  introspect(conn, schemas) {
    return introspectSqlite(conn, schemas);
  },
  createRowFetcher(conn) {
    return new SqliteRowFetcher(conn);
  },
  createSink(conn, opts) {
    return new SqliteSink(conn, { truncate: opts.truncate, tables: opts.tables }, opts.batchSize);
  },
  insertData(conn, data, opts) {
    return insertDataSqlite(conn, data, { truncate: opts.truncate, batchSize: opts.batchSize });
  },
  toScript(data) {
    return toSqlSqlite(data);
  },
};

/**
 * Does this connection string point at SQLite? Anything with an explicit
 * `sqlite:`/`file:` scheme, an in-memory marker, or a path with a SQLite file
 * extension — but never a `scheme://host` URL, which stays Postgres/MySQL.
 */
export function isSqlite(connStr: string): boolean {
  if (/^(sqlite|file):/i.test(connStr)) return true;
  if (/:\/\//.test(connStr)) return false;
  return connStr === ":memory:" || /\.(db|sqlite|sqlite3)$/i.test(connStr);
}

export function dialectFor(connStr: string): Dialect {
  if (/^(mysqlx?|mariadb):\/\//i.test(connStr)) return mysqlDialect;
  if (isSqlite(connStr)) return sqliteDialect;
  return postgresDialect;
}
