/** Tests for connection-string → dialect routing and SQLite path resolution. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { dialectFor, isSqlite, sqliteFile } from "../src/dialect.js";

test("dialectFor selects postgres/mysql/sqlite from the connection string", () => {
  assert.equal(dialectFor("postgres://localhost/db").name, "postgres");
  assert.equal(dialectFor("postgresql://localhost/db").name, "postgres");
  assert.equal(dialectFor("mysql://root@localhost/db").name, "mysql");
  assert.equal(dialectFor("mariadb://root@localhost/db").name, "mysql");
  assert.equal(dialectFor("sqlite:./app.db").name, "sqlite");
  assert.equal(dialectFor("./app.sqlite").name, "sqlite");
  assert.equal(dialectFor(":memory:").name, "sqlite");
});

test("isSqlite recognizes schemes, file extensions, and :memory:", () => {
  assert.ok(isSqlite("sqlite:foo.db"));
  assert.ok(isSqlite("sqlite::memory:"));
  assert.ok(isSqlite("file:foo.db"));
  assert.ok(isSqlite(":memory:"));
  assert.ok(isSqlite("/var/data/app.db"));
  assert.ok(isSqlite("./app.sqlite3"));
  // A scheme://host URL is never SQLite, even with a db-like path.
  assert.ok(!isSqlite("postgres://host/app.db"));
  assert.ok(!isSqlite("mysql://host/db"));
  // A bare hostname/path without a SQLite extension isn't assumed to be SQLite.
  assert.ok(!isSqlite("localhost/db"));
});

test("sqliteFile strips sqlite:/file: schemes to a filename", () => {
  assert.equal(sqliteFile("sqlite::memory:"), ":memory:");
  assert.equal(sqliteFile("sqlite:./app.db"), "./app.db");
  assert.equal(sqliteFile("sqlite://./app.db"), "./app.db");
  assert.equal(sqliteFile("sqlite:///var/app.db"), "/var/app.db");
  assert.equal(sqliteFile("file:app.db"), "app.db");
  assert.equal(sqliteFile("./bare.db"), "./bare.db");
  assert.equal(sqliteFile(":memory:"), ":memory:");
});
