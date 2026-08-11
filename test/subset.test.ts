/** Tests for subset+anonymize: FK closure, key preservation, anonymization. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { topoSort } from "../src/graph.js";
import type { Row } from "../src/generate.js";
import { anonymizeAll, collectSubset, type RowFetcher } from "../src/subset.js";
import { col, fk, idCol, schema, table } from "./helpers.js";
import type { Schema, TableInfo } from "../src/types.js";

/** In-memory fetcher backed by fixed tables of rows, keyed by table name. */
class FakeFetcher implements RowFetcher {
  constructor(private data: Record<string, Row[]>) {}
  async fetchRoots(t: TableInfo, limit: number): Promise<Row[]> {
    return (this.data[t.name] ?? []).slice(0, limit);
  }
  async fetchByKeys(t: TableInfo, columns: string[], keys: unknown[][]): Promise<Row[]> {
    const want = new Set(keys.map((k) => k.map(String).join("\u0000")));
    return (this.data[t.name] ?? []).filter((row) =>
      want.has(columns.map((c) => String(row[c])).join("\u0000")),
    );
  }
}

/** users <- orders <- order_items, plus a products table orders reference. */
function shopSchema(): Schema {
  const users = table("users", {
    columns: [idCol(), col("email", { udtName: "text" }), col("first_name")],
    primaryKey: ["id"],
    uniques: [["email"]],
  });
  const products = table("products", {
    columns: [idCol(), col("name"), col("price", { udtName: "numeric" })],
    primaryKey: ["id"],
  });
  const orders = table("orders", {
    columns: [idCol(), col("user_id", { udtName: "int4" }), col("note", { nullable: true })],
    primaryKey: ["id"],
    foreignKeys: [fk(["user_id"], "users", ["id"])],
  });
  const items = table("order_items", {
    columns: [
      idCol(),
      col("order_id", { udtName: "int4" }),
      col("product_id", { udtName: "int4" }),
      col("qty", { udtName: "int4" }),
    ],
    primaryKey: ["id"],
    foreignKeys: [fk(["order_id"], "orders", ["id"]), fk(["product_id"], "products", ["id"])],
  });
  return schema(users, products, orders, items);
}

function shopData(): Record<string, Row[]> {
  return {
    users: [
      { id: 1, email: "a@x.com", first_name: "Ann" },
      { id: 2, email: "b@x.com", first_name: "Bob" },
      { id: 3, email: "c@x.com", first_name: "Cara" },
    ],
    products: [
      { id: 10, name: "Widget", price: 9.99 },
      { id: 11, name: "Gadget", price: 19.99 },
      { id: 12, name: "Gizmo", price: 4.5 },
    ],
    orders: [
      { id: 100, user_id: 1, note: "rush" },
      { id: 101, user_id: 2, note: null },
      { id: 102, user_id: 1, note: "gift" },
    ],
    order_items: [
      { id: 1000, order_id: 100, product_id: 10, qty: 2 },
      { id: 1001, order_id: 100, product_id: 11, qty: 1 },
      { id: 1002, order_id: 102, product_id: 12, qty: 5 },
    ],
  };
}

function byKey(sel: Map<string, Row[]>, key: string): Row[] {
  return sel.get(key) ?? [];
}

test("seeding order_items pulls its FK parents transitively", async () => {
  const s = shopSchema();
  const sel = await collectSubset(s, { order_items: 10 }, new FakeFetcher(shopData()));

  // All 3 items, their 2 distinct orders, referenced users, and 3 products.
  assert.equal(byKey(sel, "public.order_items").length, 3);
  assert.deepEqual(
    byKey(sel, "public.orders").map((r) => r.id).sort(),
    [100, 102],
  );
  // orders 100 & 102 both belong to user 1 → only user 1 pulled.
  assert.deepEqual(byKey(sel, "public.users").map((r) => r.id), [1]);
  assert.deepEqual(
    byKey(sel, "public.products").map((r) => r.id).sort(),
    [10, 11, 12],
  );
});

test("closure keeps the subset referentially complete", async () => {
  const s = shopSchema();
  const sel = await collectSubset(s, { orders: 100 }, new FakeFetcher(shopData()));
  const userIds = new Set(byKey(sel, "public.users").map((r) => r.id));
  for (const o of byKey(sel, "public.orders")) {
    assert.ok(userIds.has(o.user_id), `order ${o.id} references missing user ${o.user_id}`);
  }
});

test("null FK values do not trigger a parent fetch", async () => {
  const s = schema(
    table("users", { columns: [idCol()], primaryKey: ["id"] }),
    table("orders", {
      columns: [idCol(), col("user_id", { udtName: "int4", nullable: true })],
      primaryKey: ["id"],
      foreignKeys: [fk(["user_id"], "users", ["id"])],
    }),
  );
  const sel = await collectSubset(
    s,
    { orders: 5 },
    new FakeFetcher({ orders: [{ id: 1, user_id: null }], users: [{ id: 99 }] }),
  );
  assert.equal(byKey(sel, "public.orders").length, 1);
  assert.equal(byKey(sel, "public.users").length, 0);
});

test("root limit caps seed rows", async () => {
  const s = shopSchema();
  const sel = await collectSubset(s, { users: 2 }, new FakeFetcher(shopData()));
  assert.equal(byKey(sel, "public.users").length, 2);
});

async function anonymizeShop(seed = 7) {
  const s = shopSchema();
  const { order } = topoSort(s);
  const sel = await collectSubset(s, { order_items: 10 }, new FakeFetcher(shopData()));
  return { s, order, sel, data: anonymizeAll(s, order, sel, { seed }) };
}

test("key columns are preserved so joins survive anonymization", async () => {
  const { data } = await anonymizeShop();
  const items = data.find((d) => d.table.key === "public.order_items")!.rows;
  const orderIds = new Set(
    data.find((d) => d.table.key === "public.orders")!.rows.map((r) => r.id),
  );
  const productIds = new Set(
    data.find((d) => d.table.key === "public.products")!.rows.map((r) => r.id),
  );
  // PKs and FK columns must be untouched → every child still resolves.
  for (const it of items) {
    assert.ok(orderIds.has(it.order_id), "order_id preserved and resolvable");
    assert.ok(productIds.has(it.product_id), "product_id preserved and resolvable");
  }
});

test("non-key columns are anonymized, NULLs preserved", async () => {
  const { data } = await anonymizeShop();
  const users = data.find((d) => d.table.key === "public.users")!.rows;
  const emails = users.map((r) => r.email);
  // Emails were scrubbed away from the originals.
  assert.ok(!emails.includes("a@x.com"));
  // Still look like emails and stay unique (email is a UNIQUE column).
  assert.equal(new Set(emails).size, emails.length);
  for (const e of emails) assert.match(String(e), /@/);
});

test("NULL non-key values are preserved through anonymization", async () => {
  const s = shopSchema();
  const { order } = topoSort(s);
  const sel = await collectSubset(s, { orders: 100 }, new FakeFetcher(shopData()));
  const data = anonymizeAll(s, order, sel, { seed: 7 });
  const nulled = data.find((d) => d.table.key === "public.orders")!.rows.find((r) => r.id === 101);
  assert.equal(nulled!.note, null, "NULL note preserved");
});

test("preserve keeps a non-key column's real values", async () => {
  const s = shopSchema();
  const { order } = topoSort(s);
  const sel = await collectSubset(s, { users: 10 }, new FakeFetcher(shopData()));
  const data = anonymizeAll(s, order, sel, { seed: 7, preserve: ["users.first_name"] });
  const names = data.find((d) => d.table.key === "public.users")!.rows.map((r) => r.first_name);
  assert.deepEqual(names.sort(), ["Ann", "Bob", "Cara"]);
  // email (also non-key) is still scrubbed — preserve is column-scoped.
  const emails = data.find((d) => d.table.key === "public.users")!.rows.map((r) => r.email);
  assert.ok(!emails.includes("a@x.com"));
});

test("anonymize scrubs a PII primary key and remaps its FK so joins survive", async () => {
  // accounts(email PK) <- sessions(account_email FK). Email is a natural key,
  // so it is protected by default; --anonymize opts it into scrubbing.
  const accounts = table("accounts", {
    columns: [col("email", { udtName: "text" }), col("plan")],
    primaryKey: ["email"],
    uniques: [["email"]],
  });
  const sessions = table("sessions", {
    columns: [idCol(), col("account_email", { udtName: "text" }), col("token")],
    primaryKey: ["id"],
    foreignKeys: [fk(["account_email"], "accounts", ["email"])],
  });
  const s = schema(accounts, sessions);
  const { order } = topoSort(s);
  const data = {
    accounts: [
      { email: "a@x.com", plan: "pro" },
      { email: "b@x.com", plan: "free" },
    ],
    sessions: [
      { id: 1, account_email: "a@x.com", token: "t1" },
      { id: 2, account_email: "a@x.com", token: "t2" },
      { id: 3, account_email: "b@x.com", token: "t3" },
    ],
  };
  const sel = await collectSubset(s, { sessions: 10 }, new FakeFetcher(data));
  const out = anonymizeAll(s, order, sel, { seed: 42, anonymize: ["accounts.email"] });

  const accs = out.find((d) => d.table.key === "public.accounts")!.rows;
  const sess = out.find((d) => d.table.key === "public.sessions")!.rows;
  const accEmails = accs.map((r) => r.email);

  // The PK was actually scrubbed and stays unique + email-shaped.
  assert.ok(!accEmails.includes("a@x.com") && !accEmails.includes("b@x.com"));
  assert.equal(new Set(accEmails).size, accEmails.length);
  for (const e of accEmails) assert.match(String(e), /@/);

  // Every session FK still resolves to a (now-anonymized) account.
  const valid = new Set(accEmails);
  for (const row of sess) assert.ok(valid.has(row.account_email), "FK remapped to a real parent");

  // The two sessions that shared "a@x.com" still share one fake value.
  const mapped = new Map<string, unknown>();
  for (const row of sess) {
    const orig = row.id === 3 ? "b@x.com" : "a@x.com";
    if (mapped.has(orig)) assert.equal(row.account_email, mapped.get(orig), "consistent remap");
    mapped.set(orig, row.account_email);
  }
});

test("anonymizing either side of a join forces the whole group", async () => {
  // Naming only the child FK column must still remap the parent PK.
  const accounts = table("accounts", {
    columns: [col("email", { udtName: "text" }), col("plan")],
    primaryKey: ["email"],
    uniques: [["email"]],
  });
  const sessions = table("sessions", {
    columns: [idCol(), col("account_email", { udtName: "text" })],
    primaryKey: ["id"],
    foreignKeys: [fk(["account_email"], "accounts", ["email"])],
  });
  const s = schema(accounts, sessions);
  const { order } = topoSort(s);
  const data = {
    accounts: [{ email: "a@x.com", plan: "pro" }],
    sessions: [{ id: 1, account_email: "a@x.com" }],
  };
  const sel = await collectSubset(s, { sessions: 10 }, new FakeFetcher(data));
  const out = anonymizeAll(s, order, sel, { seed: 1, anonymize: ["sessions.account_email"] });
  const acc = out.find((d) => d.table.key === "public.accounts")!.rows[0];
  const ses = out.find((d) => d.table.key === "public.sessions")!.rows[0];
  assert.notEqual(acc.email, "a@x.com", "parent PK scrubbed via child request");
  assert.equal(ses.account_email, acc.email, "child FK matches scrubbed parent");
});

/** users <- orders, where orders carries a denormalized copy of the user email. */
function denormSchema(): Schema {
  const users = table("users", {
    columns: [idCol(), col("email", { udtName: "text" }), col("first_name")],
    primaryKey: ["id"],
    uniques: [["email"]],
  });
  const orders = table("orders", {
    columns: [idCol(), col("user_id", { udtName: "int4" }), col("customer_email", { udtName: "text" })],
    primaryKey: ["id"],
    foreignKeys: [fk(["user_id"], "users", ["id"])],
  });
  return schema(users, orders);
}

function denormData(): Record<string, Row[]> {
  return {
    users: [
      { id: 1, email: "a@x.com", first_name: "Ann" },
      { id: 2, email: "b@x.com", first_name: "Bob" },
    ],
    orders: [
      { id: 100, user_id: 1, customer_email: "a@x.com" },
      { id: 101, user_id: 2, customer_email: "b@x.com" },
      { id: 102, user_id: 1, customer_email: "a@x.com" },
    ],
  };
}

test("without --link, a denormalized copy scrubs independently of its source", async () => {
  const s = denormSchema();
  const { order } = topoSort(s);
  const sel = await collectSubset(s, { orders: 10 }, new FakeFetcher(denormData()));
  const out = anonymizeAll(s, order, sel, { seed: 3 });
  const emailById = new Map(
    out.find((d) => d.table.key === "public.users")!.rows.map((u) => [u.id, u.email]),
  );
  const o100 = out.find((d) => d.table.key === "public.orders")!.rows.find((r) => r.id === 100)!;
  // The copy got its own mapping, so it no longer matches the source email.
  assert.notEqual(o100.customer_email, emailById.get(1));
});

test("--link scrubs a denormalized copy to the same fake as its source", async () => {
  const s = denormSchema();
  const { order } = topoSort(s);
  const sel = await collectSubset(s, { orders: 10 }, new FakeFetcher(denormData()));
  const out = anonymizeAll(s, order, sel, {
    seed: 3,
    link: [["users.email", "orders.customer_email"]],
  });
  const users = out.find((d) => d.table.key === "public.users")!.rows;
  const orders = out.find((d) => d.table.key === "public.orders")!.rows;
  const emailById = new Map(users.map((u) => [u.id, u.email]));
  // Every order's copied email now equals its user's (scrubbed) email.
  for (const o of orders) {
    assert.equal(o.customer_email, emailById.get(o.user_id), "copy matches source");
  }
  // Still scrubbed off the originals and email-shaped.
  assert.ok(!users.some((u) => u.email === "a@x.com" || u.email === "b@x.com"));
  for (const u of users) assert.match(String(u.email), /@/);
});

test("a bare --link pattern links every column of that name", async () => {
  const users = table("users", {
    columns: [idCol(), col("email", { udtName: "text" })],
    primaryKey: ["id"],
    uniques: [["email"]],
  });
  const events = table("events", {
    columns: [idCol(), col("user_id", { udtName: "int4" }), col("email", { udtName: "text" })],
    primaryKey: ["id"],
    foreignKeys: [fk(["user_id"], "users", ["id"])],
  });
  const s = schema(users, events);
  const { order } = topoSort(s);
  const data = {
    users: [{ id: 1, email: "a@x.com" }, { id: 2, email: "b@x.com" }],
    events: [{ id: 5, user_id: 1, email: "a@x.com" }, { id: 6, user_id: 2, email: "b@x.com" }],
  };
  const sel = await collectSubset(s, { events: 10 }, new FakeFetcher(data));
  const out = anonymizeAll(s, order, sel, { seed: 9, link: [["email"]] });
  const uById = new Map(
    out.find((d) => d.table.key === "public.users")!.rows.map((r) => [r.id, r.email]),
  );
  for (const e of out.find((d) => d.table.key === "public.events")!.rows) {
    assert.equal(e.email, uById.get(e.user_id), "linked by bare name");
  }
});

test("--link rejects a key column, pointing at --anonymize", async () => {
  const s = denormSchema();
  const { order } = topoSort(s);
  const sel = await collectSubset(s, { orders: 10 }, new FakeFetcher(denormData()));
  assert.throws(
    () => anonymizeAll(s, order, sel, { seed: 1, link: [["users.id", "orders.user_id"]] }),
    /use --anonymize/,
  );
});

test("anonymization is consistent per value and deterministic per seed", async () => {
  // first_name "Ann" appears once; add a duplicate to prove consistency.
  const s = shopSchema();
  const { order } = topoSort(s);
  const data = {
    users: [
      { id: 1, email: "a@x.com", first_name: "Sam" },
      { id: 2, email: "b@x.com", first_name: "Sam" },
    ],
  };
  const sel = await collectSubset(s, { users: 10 }, new FakeFetcher(data));
  const a = anonymizeAll(s, order, sel, { seed: 42 });
  const b = anonymizeAll(s, order, sel, { seed: 42 });
  const names = (d: typeof a) =>
    d.find((x) => x.table.key === "public.users")!.rows.map((r) => r.first_name);
  // Same original "Sam" → same fake within a run.
  const [n1, n2] = names(a);
  assert.equal(n1, n2);
  // Same seed → identical output across runs.
  assert.deepEqual(names(a), names(b));
});
