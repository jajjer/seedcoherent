/** Tests for intra-row coherence: names and addresses that agree within a row. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildData } from "../src/generate.js";
import { topoSort } from "../src/graph.js";
import { planCoherence, STATE_CITIES } from "../src/coherence.js";
import { col, idCol, schema, table } from "./helpers.js";
import type { Config, Schema } from "../src/types.js";

function build(s: Schema, config: Config) {
  const { order, cyclic } = topoSort(s);
  return buildData(s, order, cyclic, config);
}

function rowsFor(data: ReturnType<typeof build>, key: string) {
  const td = data.find((d) => d.table.key === key);
  assert.ok(td, `expected data for ${key}`);
  return td.rows;
}

/** people(id, first_name, last_name, full_name, email, username). */
function peopleTable(extra = {}): Schema {
  return schema(
    table("people", {
      columns: [
        idCol(),
        col("first_name"),
        col("last_name"),
        col("full_name"),
        col("email"),
        col("username"),
      ],
      primaryKey: ["id"],
      ...extra,
    }),
  );
}

test("full_name is the row's own first_name + last_name", () => {
  for (const r of rowsFor(build(peopleTable(), { rows: { people: 200 }, seed: 1 }), "public.people")) {
    assert.equal(r.full_name, `${r.first_name} ${r.last_name}`);
  }
});

test("email and username derive from the row's first + last name", () => {
  for (const r of rowsFor(build(peopleTable(), { rows: { people: 200 }, seed: 2 }), "public.people")) {
    const first = String(r.first_name).toLowerCase();
    const last = String(r.last_name).toLowerCase();
    const email = String(r.email);
    const user = String(r.username);
    assert.ok(
      email.includes(first) || email.includes(last),
      `email ${email} unrelated to ${first}/${last}`,
    );
    assert.ok(
      user.includes(first) || user.includes(last),
      `username ${user} unrelated to ${first}/${last}`,
    );
    assert.equal(email, email.toLowerCase());
  }
});

test("a gender/sex column biases the first name (male stays male)", () => {
  const s = schema(
    table("people", {
      columns: [idCol(), col("first_name"), col("last_name"), col("sex", {
        udtName: "gender_enum",
        dataType: "enum",
        enumValues: ["male", "female"],
      })],
      primaryKey: ["id"],
    }),
  );
  // Pin sex=male for every row; names should be drawn as male first names, and
  // the deterministic seed makes the set stable.
  const config: Config = { rows: { people: 50 }, seed: 3, columns: { "people.sex": { value: "male" } } };
  const rows = rowsFor(build(s, config), "public.people");
  for (const r of rows) assert.equal(r.sex, "male");
  // Sanity: a clearly female-only name shouldn't appear for a male-pinned column.
  const names = new Set(rows.map((r) => r.first_name));
  assert.ok(!names.has("Mary") && !names.has("Patricia"), "unexpected female name for sex=male");
});

test("a female-pinned sex column yields female first names", () => {
  const s = schema(
    table("people", {
      columns: [idCol(), col("first_name"), col("last_name"), col("sex", {
        udtName: "gender_enum",
        dataType: "enum",
        enumValues: ["male", "female"],
      })],
      primaryKey: ["id"],
    }),
  );
  const config: Config = { rows: { people: 50 }, seed: 9, columns: { "people.sex": { value: "female" } } };
  const rows = rowsFor(build(s, config), "public.people");
  for (const r of rows) assert.equal(r.sex, "female");
  // A clearly male-only name shouldn't appear for a female-pinned column.
  const names = new Set(rows.map((r) => r.first_name));
  assert.ok(!names.has("James") && !names.has("Robert"), "unexpected male name for sex=female");
});

test("a pinned first_name anchors the derived columns", () => {
  const config: Config = {
    rows: { people: 30 },
    seed: 4,
    columns: { "people.first_name": { value: "Zelda" } },
  };
  for (const r of rowsFor(build(peopleTable(), config), "public.people")) {
    assert.equal(r.first_name, "Zelda");
    assert.equal(r.full_name, `Zelda ${r.last_name}`);
    assert.ok(String(r.email).includes("zelda") || String(r.email).includes(String(r.last_name).toLowerCase()));
  }
});

test("nullable coherence columns that came out null stay null", () => {
  const s = schema(
    table("people", {
      columns: [idCol(), col("first_name"), col("last_name"), col("email", { nullable: true })],
      primaryKey: ["id"],
    }),
  );
  const rows = rowsFor(build(s, { rows: { people: 300 }, seed: 5 }), "public.people");
  const nulls = rows.filter((r) => r.email === null);
  assert.ok(nulls.length > 0, "expected some null emails from the null probability");
});

test("state, zip and country describe the same US place", () => {
  const s = schema(
    table("addresses", {
      columns: [idCol(), col("city"), col("state"), col("zip"), col("country")],
      primaryKey: ["id"],
    }),
  );
  const rows = rowsFor(build(s, { rows: { addresses: 200 }, seed: 6 }), "public.addresses");
  for (const r of rows) {
    assert.match(String(r.state), /^[A-Z]{2}$/, `state ${r.state} is not a 2-letter abbr`);
    assert.match(String(r.zip), /^\d{5}(-\d{4})?$/, `zip ${r.zip} malformed`);
    assert.equal(r.country, "United States");
  }
});

test("the city sits in the row's own state", () => {
  const s = schema(
    table("addresses", {
      columns: [idCol(), col("city"), col("state"), col("zip"), col("country")],
      primaryKey: ["id"],
    }),
  );
  const rows = rowsFor(build(s, { rows: { addresses: 300 }, seed: 6 }), "public.addresses");
  let checked = 0;
  for (const r of rows) {
    const cities = STATE_CITIES[String(r.state)];
    if (!cities) continue; // a territory we don't cover falls back to a generic city
    assert.ok(
      cities.includes(String(r.city)),
      `city ${r.city} is not in state ${r.state}`,
    );
    checked++;
  }
  assert.ok(checked > rows.length / 2, "expected most rows to hit a covered state");
});

test("state + city cohere even without a zip column", () => {
  const s = schema(
    table("locations", {
      columns: [idCol(), col("city"), col("state")],
      primaryKey: ["id"],
    }),
  );
  const rows = rowsFor(build(s, { rows: { locations: 200 }, seed: 12 }), "public.locations");
  for (const r of rows) {
    assert.match(String(r.state), /^[A-Z]{2}$/, `state ${r.state} is not a 2-letter abbr`);
    const cities = STATE_CITIES[String(r.state)];
    if (cities) assert.ok(cities.includes(String(r.city)), `city ${r.city} not in ${r.state}`);
  }
});

test("billing and shipping addresses stay independent groups", () => {
  const s = schema(
    table("orders", {
      columns: [
        idCol(),
        col("billing_state"),
        col("billing_zip"),
        col("shipping_state"),
        col("shipping_zip"),
      ],
      primaryKey: ["id"],
    }),
  );
  const rows = rowsFor(build(s, { rows: { orders: 300 }, seed: 7 }), "public.orders");
  for (const r of rows) {
    assert.match(String(r.billing_state), /^[A-Z]{2}$/);
    assert.match(String(r.shipping_state), /^[A-Z]{2}$/);
  }
  // The two groups draw independently, so they shouldn't be forced equal.
  assert.ok(
    rows.some((r) => r.billing_state !== r.shipping_state),
    "billing and shipping states are always identical — groups not independent",
  );
});

test("output stays byte-identical across runs with the same seed", () => {
  const cfg: Config = { rows: { people: 40 }, seed: 11 };
  const a = build(peopleTable(), cfg);
  const b = build(peopleTable(), cfg);
  assert.deepEqual(JSON.stringify(a), JSON.stringify(b));
});

test("planCoherence needs a full pair, not a lone column", () => {
  // Lone email → nothing to cohere with.
  const lone = table("t", { columns: [col("email")] });
  assert.equal(planCoherence(lone), null);
  // first + last → a name group.
  const named = table("u", { columns: [col("first_name"), col("last_name")] });
  assert.ok(planCoherence(named));
  // state without zip → no address group.
  const noZip = table("v", { columns: [col("state")] });
  assert.equal(planCoherence(noZip), null);
});

test("a numeric zip column is left to the ordinary generator", () => {
  // zip typed as integer must not receive a string zip code.
  const s = schema(
    table("addresses", {
      columns: [idCol(), col("state"), col("zip", { udtName: "int4" })],
      primaryKey: ["id"],
    }),
  );
  const rows = rowsFor(build(s, { rows: { addresses: 20 }, seed: 8 }), "public.addresses");
  for (const r of rows) assert.equal(typeof r.zip, "number");
});
