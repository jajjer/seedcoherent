/**
 * Intra-row value coherence: keep a row's fields agreeing with each other.
 *
 * Without this, every column is inferred independently, so a single row can come
 * out as `first_name="Sarah", full_name="John Doe", email="mia91@..."` or
 * `state="Texas", zip="90210"` (a California zip). Constraint-valid, but visibly
 * fake. This module classifies a table's name/address columns into groups that
 * describe one entity (keyed by a shared prefix, so `billing_*` and `shipping_*`
 * stay separate) and rewrites their values, per row, so that within a group:
 *   - `full_name`/`display_name`, `email`, and `username` all derive from the
 *     same `first_name` + `last_name` (and the first name respects a `gender`/
 *     `sex` column when present), and
 *   - `state`, `zip`, `city`, and `country` describe the same place — a zip that
 *     actually falls in its state and a city that really sits in it, in the US.
 *
 * Like temporal coherence, it runs as a post-pass over an already-generated row.
 * Draws come from a dedicated en_US Faker instance (US postcode-by-state data is
 * absent from the plain `en` locale) so the main generator's RNG stream — and
 * therefore every other column's seeded output — is left untouched. Columns the
 * user has pinned (`--column`), partition keys, and foreign-key columns are never
 * rewritten; an intentionally-null nullable column stays null.
 */

import type { Faker } from "@faker-js/faker";
import type { ColumnInfo, TableInfo } from "./types.js";

type Role =
  | "first"
  | "last"
  | "full"
  | "email"
  | "username"
  | "sex"
  | "state"
  | "zip"
  | "city"
  | "country";

/** Columns of one entity (shared prefix), indexed by role — a role may repeat. */
type Group = Map<Role, string[]>;

/** A table's coherence groups: at least one has enough columns to be worth it. */
export interface CoherencePlan {
  groups: Group[];
}

const norm = (s: string) => s.toLowerCase().replace(/[_\s-]+/g, "");
const toks = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * Tokens that name a column's role rather than its entity. Stripping them from a
 * column's token list leaves the entity prefix that groups related columns:
 * `billing_zip_code` → "billing", `first_name` → "", `contact_email` → "contact".
 * Includes the joined-word forms (`firstname`, `zipcode`) so an unseparated name
 * still reduces to an empty prefix.
 */
const ROLE_TOKENS = new Set([
  "first", "firstname", "given", "givenname", "fname",
  "last", "lastname", "sur", "surname", "family", "familyname", "lname",
  "middle", "middlename",
  "name", "full", "fullname", "display", "displayname", "contact", "contactname",
  "email", "emailaddress", "mail",
  "user", "username", "login", "handle",
  "gender", "sex",
  "state", "province", "region",
  "zip", "zipcode", "postal", "postalcode", "postcode", "code",
  "city", "town", "municipality",
  "country", "nation",
  "address", "addr",
]);

/** Roles whose value we overwrite; each must land in a text-typed column. */
const WRITE_ROLES: ReadonlySet<Role> = new Set<Role>([
  "first", "last", "full", "email", "username", "state", "zip", "city", "country",
]);

interface MatchCtx {
  n: string;
  tokens: string[];
}

const has = (n: string, ...frags: string[]) => frags.some((f) => n.includes(f));
const tok = (tokens: string[], ...names: string[]) => names.some((x) => tokens.includes(x));

/** Text-typed? Only these columns can safely hold a generated name/place string. */
function isText(col: ColumnInfo): boolean {
  return col.dataType === "text";
}

/**
 * Classify a column into a coherence role + entity prefix, or null. Roles are
 * tested most-specific first (so `first_name` is a first name, not a full name),
 * mirroring infer.ts's name rules. Write roles are gated to text columns; the
 * read-only `sex` role also accepts an enum (its labels are strings we only read).
 */
function classify(col: ColumnInfo): { role: Role; prefix: string } | null {
  const ctx: MatchCtx = { n: norm(col.name), tokens: toks(col.name) };
  const role = roleOf(ctx);
  if (!role) return null;
  if (WRITE_ROLES.has(role)) {
    if (!isText(col)) return null;
  } else if (col.dataType !== "text" && col.dataType !== "enum") {
    return null; // sex: text or enum only
  }
  const prefix = ctx.tokens.filter((t) => !ROLE_TOKENS.has(t)).join("");
  return { role, prefix };
}

function roleOf({ n, tokens }: MatchCtx): Role | null {
  if (has(n, "email")) return "email";
  if (tok(tokens, "username", "login", "handle")) return "username";
  if (has(n, "firstname", "givenname")) return "first";
  if (has(n, "lastname", "surname", "familyname")) return "last";
  if (has(n, "fullname", "displayname", "contactname") || n === "name") return "full";
  if (tok(tokens, "gender", "sex")) return "sex";
  if (tok(tokens, "state", "province", "region")) return "state";
  if (has(n, "zipcode", "postalcode", "postcode") || tok(tokens, "zip")) return "zip";
  if (tok(tokens, "city", "town", "municipality")) return "city";
  if (tok(tokens, "country")) return "country";
  return null;
}

/** Does this group have enough columns for name coherence (a first AND a last)? */
function hasName(g: Group): boolean {
  return g.has("first") && g.has("last");
}

/**
 * Does this group have enough columns for address coherence? A state anchors the
 * place, so it's required, plus at least one field to make agree with it — a zip
 * (a real code inside the state) or a city (a real city that sits in it).
 */
function hasAddress(g: Group): boolean {
  return g.has("state") && (g.has("zip") || g.has("city"));
}

/**
 * Build a table's coherence plan, or null when nothing coheres. Columns are
 * grouped by entity prefix; a group is kept only if it can actually enforce name
 * coherence (needs both a first and last name) or address coherence (needs a
 * state plus a zip or a city) — a lone `email` or `zip` has nothing to agree with
 * and is left to the ordinary generator.
 */
export function planCoherence(table: TableInfo): CoherencePlan | null {
  const byPrefix = new Map<string, Group>();
  for (const col of table.columns) {
    const cls = classify(col);
    if (!cls) continue;
    let g = byPrefix.get(cls.prefix);
    if (!g) byPrefix.set(cls.prefix, (g = new Map()));
    const arr = g.get(cls.role) ?? [];
    arr.push(col.name);
    g.set(cls.role, arr);
  }
  const groups = [...byPrefix.values()].filter((g) => hasName(g) || hasAddress(g));
  return groups.length ? { groups } : null;
}

/** Map a `gender`/`sex` column value onto a faker SexType, or undefined. */
function sexHint(v: unknown): "male" | "female" | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase();
  if (s === "male" || s === "m") return "male";
  if (s === "female" || s === "f") return "female";
  return undefined;
}

/** The row's current string value for a column, or undefined if not a string. */
function strVal(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Rewrite a row's name/address columns in place so a group's fields agree.
 * `eligible` is true for columns the generator owns (excludes FK-driven columns);
 * `frozen` names user-pinned / partition-key columns to leave verbatim. A column
 * that is frozen still anchors its group (so derived values follow the pinned
 * name/place), and an intentionally-null nullable column is preserved. All draws
 * use `f` (an en_US Faker), so output stays deterministic under a seed.
 */
export function applyCoherence(
  plan: CoherencePlan,
  row: Record<string, unknown>,
  f: Faker,
  eligible: (colName: string) => boolean,
  frozen: (colName: string) => boolean,
): void {
  const write = (colName: string, value: unknown) => {
    if (!eligible(colName) || frozen(colName)) return;
    if (row[colName] == null) return; // keep an intentionally-null nullable column
    row[colName] = value;
  };
  const writeAll = (cols: string[] | undefined, value: (col: string) => unknown) => {
    for (const c of cols ?? []) write(c, value(c));
  };

  for (const g of plan.groups) {
    if (hasName(g)) {
      const firstCol = g.get("first")![0];
      const lastCol = g.get("last")![0];
      const sexCol = g.get("sex")?.[0];
      // A frozen column keeps its pinned value and anchors the rest; a frozen
      // (or absent) value falls back to a fresh draw so derived fields still cohere.
      const fresh = f.person.firstName(sexCol ? sexHint(row[sexCol]) : undefined);
      const freshLast = f.person.lastName();
      const first = (frozen(firstCol) ? strVal(row[firstCol]) : undefined) ?? fresh;
      const last = (frozen(lastCol) ? strVal(row[lastCol]) : undefined) ?? freshLast;

      writeAll(g.get("first"), () => first);
      writeAll(g.get("last"), () => last);
      writeAll(g.get("full"), () => `${first} ${last}`);
      writeAll(g.get("email"), () => f.internet.email({ firstName: first, lastName: last }).toLowerCase());
      writeAll(g.get("username"), () =>
        f.internet.username({ firstName: first, lastName: last }).toLowerCase(),
      );
    }

    if (hasAddress(g)) {
      // Draw the state first — it anchors the place — then the zip and city that
      // sit inside it. Ordering matters for determinism: city is drawn last so a
      // schema that gains a city column keeps its existing state/zip output.
      const abbr = f.location.state({ abbreviated: true });
      writeAll(g.get("state"), () => abbr);
      writeAll(g.get("zip"), () => zipForState(f, abbr));
      writeAll(g.get("city"), () => cityForState(f, abbr));
      writeAll(g.get("country"), () => "United States");
    }
  }
}

/** A zip within `stateAbbr`, falling back to any US zip if state data is missing. */
function zipForState(f: Faker, stateAbbr: string): string {
  try {
    return f.location.zipCode({ state: stateAbbr });
  } catch {
    return f.location.zipCode();
  }
}

/**
 * A real city that sits in `stateAbbr`. Faker's `location.city()` invents plausible
 * names untied to any state (it ignores a `{ state }` option), so a curated list of
 * well-known cities per state is what keeps the city coherent with its state. Falls
 * back to a generic Faker city if the abbreviation isn't one we cover (e.g. a US
 * territory), which is rare and still constraint-valid.
 */
function cityForState(f: Faker, stateAbbr: string): string {
  const cities = STATE_CITIES[stateAbbr];
  return cities ? f.helpers.arrayElement(cities) : f.location.city();
}

/**
 * Well-known real cities per US state (and DC), keyed by two-letter abbreviation to
 * match `location.state({ abbreviated: true })`. A handful each is enough for
 * variety; every entry genuinely sits in its state so `state`/`city` always agree.
 */
export const STATE_CITIES: Record<string, string[]> = {
  AL: ["Birmingham", "Montgomery", "Huntsville", "Mobile"],
  AK: ["Anchorage", "Fairbanks", "Juneau"],
  AZ: ["Phoenix", "Tucson", "Mesa", "Scottsdale"],
  AR: ["Little Rock", "Fayetteville", "Fort Smith"],
  CA: ["Los Angeles", "San Francisco", "San Diego", "Sacramento", "San Jose"],
  CO: ["Denver", "Colorado Springs", "Boulder", "Aurora"],
  CT: ["Hartford", "New Haven", "Stamford", "Bridgeport"],
  DE: ["Wilmington", "Dover", "Newark"],
  DC: ["Washington"],
  FL: ["Miami", "Orlando", "Tampa", "Jacksonville", "Tallahassee"],
  GA: ["Atlanta", "Savannah", "Augusta", "Athens"],
  HI: ["Honolulu", "Hilo", "Kailua"],
  ID: ["Boise", "Nampa", "Idaho Falls"],
  IL: ["Chicago", "Springfield", "Naperville", "Peoria"],
  IN: ["Indianapolis", "Fort Wayne", "Evansville", "Bloomington"],
  IA: ["Des Moines", "Cedar Rapids", "Davenport"],
  KS: ["Wichita", "Overland Park", "Topeka"],
  KY: ["Louisville", "Lexington", "Bowling Green"],
  LA: ["New Orleans", "Baton Rouge", "Shreveport", "Lafayette"],
  ME: ["Portland", "Augusta", "Bangor"],
  MD: ["Baltimore", "Annapolis", "Rockville", "Frederick"],
  MA: ["Boston", "Worcester", "Cambridge", "Springfield"],
  MI: ["Detroit", "Grand Rapids", "Ann Arbor", "Lansing"],
  MN: ["Minneapolis", "Saint Paul", "Rochester", "Duluth"],
  MS: ["Jackson", "Gulfport", "Biloxi"],
  MO: ["Kansas City", "St. Louis", "Springfield", "Columbia"],
  MT: ["Billings", "Missoula", "Bozeman", "Helena"],
  NE: ["Omaha", "Lincoln", "Bellevue"],
  NV: ["Las Vegas", "Reno", "Henderson", "Carson City"],
  NH: ["Manchester", "Nashua", "Concord"],
  NJ: ["Newark", "Jersey City", "Trenton", "Princeton"],
  NM: ["Albuquerque", "Santa Fe", "Las Cruces"],
  NY: ["New York", "Buffalo", "Rochester", "Albany", "Syracuse"],
  NC: ["Charlotte", "Raleigh", "Durham", "Greensboro", "Asheville"],
  ND: ["Fargo", "Bismarck", "Grand Forks"],
  OH: ["Columbus", "Cleveland", "Cincinnati", "Toledo", "Dayton"],
  OK: ["Oklahoma City", "Tulsa", "Norman"],
  OR: ["Portland", "Salem", "Eugene", "Bend"],
  PA: ["Philadelphia", "Pittsburgh", "Harrisburg", "Allentown"],
  RI: ["Providence", "Warwick", "Newport"],
  SC: ["Columbia", "Charleston", "Greenville"],
  SD: ["Sioux Falls", "Rapid City", "Pierre"],
  TN: ["Nashville", "Memphis", "Knoxville", "Chattanooga"],
  TX: ["Houston", "Dallas", "Austin", "San Antonio", "Fort Worth"],
  UT: ["Salt Lake City", "Provo", "Ogden", "St. George"],
  VT: ["Burlington", "Montpelier", "Rutland"],
  VA: ["Virginia Beach", "Richmond", "Norfolk", "Arlington", "Alexandria"],
  WA: ["Seattle", "Spokane", "Tacoma", "Olympia", "Bellevue"],
  WV: ["Charleston", "Huntington", "Morgantown"],
  WI: ["Milwaukee", "Madison", "Green Bay"],
  WY: ["Cheyenne", "Casper", "Laramie"],
};
