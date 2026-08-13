/** Tests for --locale: locale-aware value generation and its effect on coherence. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildData } from "../src/generate.js";
import { topoSort } from "../src/graph.js";
import { resolveLocale } from "../src/locale.js";
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

/** people(id, first_name, last_name, full_name, email). */
function peopleTable(): Schema {
  return schema(
    table("people", {
      columns: [idCol(), col("first_name"), col("last_name"), col("full_name"), col("email")],
      primaryKey: ["id"],
    }),
  );
}

/** addresses(id, city, state, zip, country). */
function addressTable(): Schema {
  return schema(
    table("addresses", {
      columns: [idCol(), col("city"), col("state"), col("zip"), col("country")],
      primaryKey: ["id"],
    }),
  );
}

test("resolveLocale: default and en_US enable US address coherence, others don't", () => {
  assert.equal(resolveLocale(undefined).usAddress, true);
  assert.equal(resolveLocale("en_US").usAddress, true);
  assert.equal(resolveLocale("de").usAddress, false);
  assert.equal(resolveLocale("fr").usAddress, false);
});

test("resolveLocale: normalizes dashes to underscores", () => {
  assert.doesNotThrow(() => resolveLocale("en-GB"));
  assert.doesNotThrow(() => resolveLocale("pt-BR"));
  assert.equal(resolveLocale("en-US").usAddress, true);
});

test("resolveLocale: rejects an unknown code with the list of valid ones", () => {
  assert.throws(() => resolveLocale("klingon"), /Unknown --locale 'klingon'/);
  // `base` is an internal Faker locale, not a user-selectable one.
  assert.throws(() => resolveLocale("base"), /Unknown --locale/);
});

test("an unset locale is byte-identical to the default", () => {
  const a = rowsFor(build(peopleTable(), { rows: { people: 50 }, seed: 9 }), "public.people");
  const b = rowsFor(
    build(peopleTable(), { rows: { people: 50 }, seed: 9, locale: undefined }),
    "public.people",
  );
  assert.deepEqual(a, b);
});

test("a locale is deterministic under a seed", () => {
  const cfg: Config = { rows: { people: 50 }, seed: 3, locale: "de" };
  assert.deepEqual(
    rowsFor(build(peopleTable(), cfg), "public.people"),
    rowsFor(build(peopleTable(), cfg), "public.people"),
  );
});

test("a non-US locale changes generated values", () => {
  const us = rowsFor(build(peopleTable(), { rows: { people: 50 }, seed: 5 }), "public.people");
  const de = rowsFor(
    build(peopleTable(), { rows: { people: 50 }, seed: 5, locale: "de" }),
    "public.people",
  );
  const usNames = us.map((r) => r.full_name).join("|");
  const deNames = de.map((r) => r.full_name).join("|");
  assert.notEqual(usNames, deNames);
});

test("name coherence still holds under a non-US locale", () => {
  const rows = rowsFor(
    build(peopleTable(), { rows: { people: 100 }, seed: 4, locale: "de" }),
    "public.people",
  );
  for (const r of rows) {
    assert.equal(r.full_name, `${r.first_name} ${r.last_name}`);
    assert.equal(String(r.email), String(r.email).toLowerCase());
  }
});

test("US address coherence still applies under an explicit en_US locale", () => {
  const rows = rowsFor(
    build(addressTable(), { rows: { addresses: 100 }, seed: 6, locale: "en_US" }),
    "public.addresses",
  );
  for (const r of rows) {
    assert.match(String(r.state), /^[A-Z]{2}$/, `state ${r.state} is not a 2-letter abbr`);
    assert.equal(r.country, "United States");
  }
});

test("a non-US locale skips US address coherence (in-locale values instead)", () => {
  const rows = rowsFor(
    build(addressTable(), { rows: { addresses: 100 }, seed: 6, locale: "de" }),
    "public.addresses",
  );
  // No row is forced into the US shape: states aren't 2-letter US abbreviations
  // and the country isn't the hardcoded English "United States".
  const anyUsState = rows.some((r) => /^[A-Z]{2}$/.test(String(r.state)));
  assert.equal(anyUsState, false, "a non-US locale should not emit 2-letter US state abbreviations");
  for (const r of rows) {
    assert.notEqual(r.country, "United States");
  }
});
