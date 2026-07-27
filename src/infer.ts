/**
 * Semantic inference: turn a column (name + type) into a value generator.
 * This is where output stops looking like Faker noise and starts looking real —
 * `email` yields emails, `first_name` yields first names, `price` yields money.
 */

import { Faker } from "@faker-js/faker";
import type { ColumnCheck, ColumnInfo, ColumnOverride, TableInfo } from "./types.js";

export type Generator = (f: Faker) => unknown;

/** Normalize a column name for matching: lowercase, strip separators. */
function norm(name: string): string {
  return name.toLowerCase().replace(/[_\s-]+/g, "");
}

/** Split into lowercased tokens across underscores/hyphens and camelCase. */
function tokenize(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

interface MatchCtx {
  /** Whole-string, separators removed: "shippingcity". */
  n: string;
  /** Token list: ["shipping", "city"]. */
  tokens: string[];
}

/** A name-based rule: if the column name matches, use this generator. */
interface NameRule {
  test: (c: MatchCtx) => boolean;
  gen: Generator;
}

/** Substring match on the joined name — for long, unambiguous fragments. */
const has = (...frags: string[]) => (c: MatchCtx) => frags.some((f) => c.n.includes(f));
/** Whole-token match — for short/ambiguous fragments ("ip", "lat", "name"). */
const tok = (...names: string[]) => (c: MatchCtx) => names.some((x) => c.tokens.includes(x));
/** Combine matchers: true if any matches. */
const or = (...fns: Array<(c: MatchCtx) => boolean>) => (c: MatchCtx) => fns.some((fn) => fn(c));

/** Ordered — first match wins, so put specific rules before generic ones. */
const NAME_RULES: NameRule[] = [
  { test: has("email"), gen: (f) => f.internet.email().toLowerCase() },
  { test: tok("username", "login", "handle"), gen: (f) => f.internet.username().toLowerCase() },
  { test: has("password", "passwd", "pwd"), gen: (f) => f.internet.password() },
  { test: has("firstname", "givenname"), gen: (f) => f.person.firstName() },
  { test: has("lastname", "surname", "familyname"), gen: (f) => f.person.lastName() },
  { test: has("middlename"), gen: (f) => f.person.firstName() },
  { test: has("fullname", "displayname"), gen: (f) => f.person.fullName() },
  { test: (c) => c.n === "name" || c.n.includes("contactname"), gen: (f) => f.person.fullName() },
  { test: has("company", "organization", "organisation", "employer"), gen: (f) => f.company.name() },
  { test: or(has("jobtitle", "occupation"), tok("position", "role")), gen: (f) => f.person.jobTitle() },
  { test: or(has("phone", "mobile"), tok("cell", "fax")), gen: (f) => f.phone.number() },
  { test: or(has("avatar", "profilepic", "thumbnail"), tok("photo", "picture", "image")), gen: (f) => f.image.url() },
  { test: has("website", "homepage"), gen: (f) => f.internet.url() },
  { test: has("useragent"), gen: (f) => f.internet.userAgent() },
  { test: or(has("ipaddress", "ipaddr"), tok("ip")), gen: (f) => f.internet.ipv4() },
  { test: or(has("macaddress"), tok("mac")), gen: (f) => f.internet.mac() },
  { test: tok("url", "uri", "link", "href"), gen: (f) => f.internet.url() },
  { test: or(has("permalink"), tok("slug")), gen: (f) => f.lorem.slug() },
  { test: has("addressline", "streetaddress", "street"), gen: (f) => f.location.streetAddress() },
  { test: tok("address"), gen: (f) => f.location.streetAddress() },
  { test: tok("city", "town"), gen: (f) => f.location.city() },
  { test: tok("state", "province", "region"), gen: (f) => f.location.state() },
  { test: tok("country"), gen: (f) => f.location.country() },
  { test: or(has("zipcode", "postalcode", "postcode"), tok("zip")), gen: (f) => f.location.zipCode() },
  { test: or(has("latitude"), tok("lat")), gen: (f) => f.location.latitude() },
  { test: or(has("longitude"), tok("lng", "lon")), gen: (f) => f.location.longitude() },
  { test: has("timezone"), gen: (f) => f.location.timeZone() },
  { test: tok("currency"), gen: (f) => f.finance.currencyCode() },
  { test: tok("iban"), gen: (f) => f.finance.iban() },
  { test: has("creditcard", "cardnumber"), gen: (f) => f.finance.creditCardNumber() },
  { test: or(has("price", "amount", "subtotal", "salary"), tok("cost", "total", "balance", "fee")), gen: (f) => Number(f.commerce.price()) },
  { test: has("productname"), gen: (f) => f.commerce.productName() },
  { test: tok("product"), gen: (f) => f.commerce.product() },
  { test: has("color", "colour"), gen: (f) => f.color.human() },
  { test: or(has("headline"), tok("title", "subject")), gen: (f) => f.lorem.sentence({ min: 2, max: 6 }).replace(/\.$/, "") },
  { test: or(has("description"), tok("summary", "bio", "about", "body", "content", "message", "comment", "text", "note", "notes")), gen: (f) => f.lorem.paragraph() },
  { test: or(has("firstseen", "createdat", "insertedat", "registeredat"), tok("created")), gen: (f) => f.date.past({ years: 2 }) },
  { test: has("updatedat", "modifiedat", "lastseen", "lastlogin"), gen: (f) => f.date.recent({ days: 30 }) },
  { test: has("deletedat", "expiresat", "expiredat"), gen: (f) => f.date.future({ years: 1 }) },
  { test: or(has("birthdate", "dateofbirth", "birthday"), tok("dob")), gen: (f) => f.date.birthdate() },
  { test: tok("gender", "sex"), gen: (f) => f.person.sexType() },
  { test: tok("uuid", "guid"), gen: (f) => f.string.uuid() },
];

/** Type-category fallback when no name rule matches. */
function generatorForType(col: ColumnInfo): Generator {
  const max = col.maxLength ?? undefined;
  switch (col.dataType) {
    case "enum":
      return (f) => f.helpers.arrayElement(col.enumValues!);
    case "boolean":
      return (f) => f.datatype.boolean();
    case "uuid":
      return (f) => f.string.uuid();
    case "integer":
      return (f) => f.number.int({ min: 0, max: col.udtName === "int2" ? 30000 : 1_000_000 });
    case "decimal": {
      const scale = col.numericScale ?? 2;
      return (f) => f.number.float({ min: 0, max: 100000, fractionDigits: Math.min(scale, 6) });
    }
    case "date":
      return (f) => f.date.past({ years: 3 });
    case "time":
      return (f) => `${f.date.anytime().toTimeString().slice(0, 8)}`;
    case "timestamp":
      return (f) => f.date.past({ years: 2 });
    case "json":
      return (f) => ({ id: f.string.uuid(), value: f.lorem.word() });
    case "bytea":
      return (f) => Buffer.from(f.string.alphanumeric(16));
    case "inet":
      return (f) => f.internet.ipv4();
    case "array":
      return (f) => f.helpers.multiple(() => f.lorem.word(), { count: { min: 0, max: 3 } });
    case "text":
    default:
      return (f) => {
        const word = f.lorem.words({ min: 1, max: 3 });
        return max && word.length > max ? word.slice(0, max) : word;
      };
  }
}

/** Resolve a faker path like "internet.email" against a Faker instance. */
function resolveFakerPath(path: string): Generator {
  const parts = path.split(".");
  return (f) => {
    let node: any = f;
    for (const p of parts) node = node?.[p];
    if (typeof node !== "function") {
      throw new Error(`Invalid faker path "${path}" (not a function)`);
    }
    // Rebind to its parent module so faker's internal `this` is correct.
    const parent = parts.slice(0, -1).reduce<any>((acc, p) => acc?.[p], f);
    return node.call(parent);
  };
}

function overrideToGenerator(o: ColumnOverride): Generator {
  if (typeof o === "string") return resolveFakerPath(o);
  if ("faker" in o) return resolveFakerPath(o.faker);
  if ("values" in o) return (f) => f.helpers.arrayElement(o.values);
  return () => o.value;
}

/**
 * Pick the generator for a column, honoring user overrides first, then name
 * heuristics, then type. Overrides are keyed by "table.column" or bare "column".
 * A `check` (distilled from CHECK constraints) is applied last so generated
 * values stay inside what the database will accept.
 */
export function inferGenerator(
  table: TableInfo,
  col: ColumnInfo,
  overrides: Record<string, ColumnOverride> = {},
  check?: ColumnCheck,
): Generator {
  const qualified = overrides[`${table.name}.${col.name}`] ?? overrides[`${table.key}.${col.name}`];
  const bare = overrides[col.name];
  // An explicit override is the user's stated intent — respect it verbatim.
  if (qualified) return overrideToGenerator(qualified);
  if (bare) return overrideToGenerator(bare);

  const base = baseGenerator(table, col);
  return check ? applyCheck(base, col, check) : base;
}

/** Name/type generator selection, before any CHECK constraint is applied. */
function baseGenerator(table: TableInfo, col: ColumnInfo): Generator {
  // Enum columns must draw from their allowed labels regardless of the name.
  if (col.dataType === "enum") return generatorForType(col);

  const ctx: MatchCtx = { n: norm(col.name), tokens: tokenize(col.name) };
  for (const rule of NAME_RULES) {
    if (rule.test(ctx)) {
      // Only accept a name-based text/date rule if the column type is compatible;
      // e.g. don't stuff a paragraph into an integer column named "comment_count".
      if (isCompatible(col)) return rule.gen;
    }
  }
  return generatorForType(col);
}

/** Wrap a base generator so its output satisfies a column's CHECK bounds. */
function applyCheck(base: Generator, col: ColumnInfo, check: ColumnCheck): Generator {
  // A membership set fully determines the valid values — draw straight from it.
  if (check.in && check.in.length > 0) {
    const values = check.in;
    return (f) => f.helpers.arrayElement(values);
  }

  const isNumeric = col.dataType === "integer" || col.dataType === "decimal";
  if (isNumeric && (check.min !== undefined || check.max !== undefined)) {
    return boundedNumber(col, check);
  }

  if (col.dataType === "text" && (check.minLength !== undefined || check.maxLength !== undefined)) {
    return (f) => constrainLength(String(base(f)), col, check, f);
  }

  return base;
}

/** Build a number generator confined to a CHECK's inclusive/exclusive bounds. */
function boundedNumber(col: ColumnInfo, check: ColumnCheck): Generator {
  const SPAN = 1000;
  if (col.dataType === "integer") {
    let lo = check.min !== undefined ? Math.ceil(check.min) + (check.minExclusive ? 1 : 0) : undefined;
    let hi = check.max !== undefined ? Math.floor(check.max) - (check.maxExclusive ? 1 : 0) : undefined;
    if (lo === undefined) lo = hi! - SPAN;
    if (hi === undefined) hi = lo + SPAN;
    if (lo > hi) hi = lo;
    const [min, max] = [lo, hi];
    return (f) => f.number.int({ min, max });
  }
  const scale = Math.min(col.numericScale ?? 2, 6);
  const eps = Math.pow(10, -scale);
  let lo = check.min !== undefined ? check.min + (check.minExclusive ? eps : 0) : undefined;
  let hi = check.max !== undefined ? check.max - (check.maxExclusive ? eps : 0) : undefined;
  if (lo === undefined) lo = Math.min(0, hi!);
  if (hi === undefined) hi = lo + SPAN;
  if (lo > hi) hi = lo;
  const [min, max] = [lo, hi];
  return (f) => f.number.float({ min, max, fractionDigits: scale });
}

/** Pad or truncate a string to satisfy length bounds (and varchar(n)). */
function constrainLength(s: string, col: ColumnInfo, check: ColumnCheck, f: Faker): string {
  const min = check.minLength ?? 0;
  let max = check.maxLength ?? Infinity;
  if (col.maxLength) max = Math.min(max, col.maxLength);
  while (s.length < min) s += f.string.alpha(min - s.length);
  if (s.length > max) s = s.slice(0, max);
  return s;
}

/** Coarse guard so name heuristics don't violate the column's actual type. */
function isCompatible(col: ColumnInfo): boolean {
  // Name rules produce strings/numbers/dates. Reject when the column is a type
  // that clearly can't hold text (numeric/boolean/uuid) — those fall through to
  // the type generator instead.
  const textOnlyUnsafe = ["integer", "decimal", "boolean", "uuid"];
  return !textOnlyUnsafe.includes(col.dataType);
}
