-- A small e-commerce-ish SQLite schema used by the README demo (demo/demo.tape).
-- Same shape as examples/schema.sql, in SQLite dialect: a self-referential
-- category tree, users, products, orders, and order_items — enough foreign
-- keys, a UNIQUE, and CHECK-based enums to show referential coherence.

CREATE TABLE categories (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  parent_id  INTEGER REFERENCES categories(id)
);

CREATE TABLE users (
  id          INTEGER PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  first_name  TEXT NOT NULL,
  last_name   TEXT NOT NULL,
  phone       TEXT,
  country     TEXT,
  created_at  DATETIME NOT NULL
);

CREATE TABLE products (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  price        NUMERIC NOT NULL CHECK (price > 0),
  category_id  INTEGER NOT NULL REFERENCES categories(id),
  in_stock     BOOLEAN NOT NULL DEFAULT 1
);

CREATE TABLE orders (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  status      TEXT NOT NULL CHECK (status IN ('pending','paid','shipped','delivered','cancelled')),
  total       NUMERIC NOT NULL,
  created_at  DATETIME NOT NULL
);

CREATE TABLE order_items (
  id          INTEGER PRIMARY KEY,
  order_id    INTEGER NOT NULL REFERENCES orders(id),
  product_id  INTEGER NOT NULL REFERENCES products(id),
  quantity    INTEGER NOT NULL CHECK (quantity > 0)
);
