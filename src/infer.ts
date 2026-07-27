/**
 * Semantic inference: turn a column (name + type) into a value generator.
 * This is where output stops looking like Faker noise and starts looking real —
 * `email` yields emails, `first_name` yields first names, `price` yields money.
 */

import { Faker } from "@faker-js/faker";
import type {
  ColumnCheck,
  ColumnInfo,
  ColumnOverride,
  PartitionInfo,
  TableInfo,
  TypeRef,
} from "./types.js";

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
    case "array": {
      const elemGen = col.elementType ? typeRefGenerator(col.elementType) : (f: Faker) => f.lorem.word();
      return (f) => f.helpers.multiple(() => elemGen(f), { count: { min: 0, max: 3 } });
    }
    case "composite":
      return compositeGenerator(col.compositeFields ?? []);
    case "range":
      return rangeGenerator(col.rangeSubtype);
    case "text":
    default:
      return (f) => {
        const word = f.lorem.words({ min: 1, max: 3 });
        return max && word.length > max ? word.slice(0, max) : word;
      };
  }
}

/** Minimal ColumnInfo so a nested type (array element, composite field) can reuse generatorForType. */
function refToColumn(ref: TypeRef): ColumnInfo {
  return {
    name: "",
    udtName: ref.udtName,
    dataType: ref.dataType,
    enumValues: ref.enumValues,
    nullable: false,
    hasDefault: false,
    defaultExpr: null,
    isIdentity: false,
    isGenerated: false,
    maxLength: null,
    numericPrecision: null,
    numericScale: null,
  };
}

/** A value generator for a resolved element/field type (arrays, composite fields). */
function typeRefGenerator(ref: TypeRef): Generator {
  return generatorForType(refToColumn(ref));
}

/**
 * Composite (row) type: emit a Postgres record literal like `("a b",1,"x")`.
 * Producing a valid literal string lets it flow through the ordinary string
 * path in both the SQL and COPY emitters — Postgres coerces it to the row type.
 */
function compositeGenerator(fields: TypeRef[]): Generator {
  const gens = fields.map((fld) => typeRefGenerator(fld));
  return (f) => `(${gens.map((g) => recordField(g(f))).join(",")})`;
}

/** Format one composite field for a record literal (NULL is an empty, unquoted field). */
function recordField(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "t" : "f";
  const s = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
  // Quote every scalar so commas/spaces/empties survive; escape " and \ with a backslash.
  return `"${s.replace(/([\\"])/g, "\\$1")}"`;
}

/** Range type: emit a `[lower,upper)` literal with a coherent lower < upper. */
function rangeGenerator(sub: TypeRef | undefined): Generator {
  const cat = sub?.dataType;
  return (f) => {
    if (cat === "integer") {
      const a = f.number.int({ min: 0, max: 100_000 });
      return `[${a},${a + f.number.int({ min: 1, max: 1000 })})`;
    }
    if (cat === "decimal") {
      const a = f.number.float({ min: 0, max: 100_000, fractionDigits: 2 });
      return `[${a},${(a + f.number.float({ min: 1, max: 1000, fractionDigits: 2 })).toFixed(2)})`;
    }
    const a = f.date.past({ years: 2 });
    const b = new Date(a.getTime() + f.number.int({ min: 1, max: 365 }) * 86_400_000);
    if (cat === "date") return `[${a.toISOString().slice(0, 10)},${b.toISOString().slice(0, 10)})`;
    return `["${a.toISOString()}","${b.toISOString()}")`;
  };
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

  // A regex fully dictates the string format (zip codes, product SKUs, ...).
  if (check.pattern) {
    const gen = patternGenerator(check.pattern);
    if (gen) return gen;
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

// ---- minimal regex sampler ----
// Enough to satisfy the anchored patterns real domain/CHECK constraints use
// (digit runs, character classes, quantifiers, simple alternation). Anything it
// can't parse yields null, and the caller keeps the unconstrained generator.

type ReNode =
  | { t: "seq"; items: ReNode[] }
  | { t: "alt"; opts: ReNode[] }
  | { t: "rep"; node: ReNode; min: number; max: number }
  | { t: "class"; chars: string[] }
  | { t: "lit"; s: string };

const MAX_REP = 4;

/** Build a generator producing strings that match `pattern`, or null if unsupported. */
function patternGenerator(pattern: string): Generator | null {
  let src = pattern;
  if (src.startsWith("^")) src = src.slice(1);
  if (/[^\\]\$$|^\$$/.test(src)) src = src.slice(0, -1); // trailing, unescaped `$`
  try {
    const c = { s: src, i: 0 };
    const node = parseAlt(c);
    if (c.i !== src.length) return null; // trailing unparsed input
    return (f) => emitNode(node, f);
  } catch {
    return null;
  }
}

function parseAlt(c: { s: string; i: number }): ReNode {
  const opts = [parseSeq(c)];
  while (c.s[c.i] === "|") {
    c.i++;
    opts.push(parseSeq(c));
  }
  return opts.length === 1 ? opts[0] : { t: "alt", opts };
}

function parseSeq(c: { s: string; i: number }): ReNode {
  const items: ReNode[] = [];
  while (c.i < c.s.length && c.s[c.i] !== "|" && c.s[c.i] !== ")") {
    items.push(parseRep(c));
  }
  return { t: "seq", items };
}

function parseRep(c: { s: string; i: number }): ReNode {
  const atom = parseAtom(c);
  const ch = c.s[c.i];
  if (ch === "*") return (c.i++, { t: "rep", node: atom, min: 0, max: MAX_REP });
  if (ch === "+") return (c.i++, { t: "rep", node: atom, min: 1, max: MAX_REP });
  if (ch === "?") return (c.i++, { t: "rep", node: atom, min: 0, max: 1 });
  if (ch === "{") {
    const close = c.s.indexOf("}", c.i);
    if (close === -1) throw new Error("unterminated {");
    const body = c.s.slice(c.i + 1, close);
    const m = body.match(/^(\d+)(,(\d*)?)?$/);
    if (!m) throw new Error("bad quantifier");
    const min = Number(m[1]);
    const max = m[2] === undefined ? min : m[3] ? Number(m[3]) : min + MAX_REP;
    c.i = close + 1;
    return { t: "rep", node: atom, min, max };
  }
  return atom;
}

function parseAtom(c: { s: string; i: number }): ReNode {
  const ch = c.s[c.i];
  if (ch === "(") {
    c.i++;
    // Skip a non-capturing group marker `?:`.
    if (c.s.startsWith("?:", c.i)) c.i += 2;
    const inner = parseAlt(c);
    if (c.s[c.i] !== ")") throw new Error("unbalanced (");
    c.i++;
    return inner;
  }
  if (ch === "[") return parseClass(c);
  if (ch === "\\") return parseEscape(c);
  if (ch === ".") return (c.i++, { t: "class", chars: expandRange("a", "z") });
  if (ch === undefined || "*+?{}|)".includes(ch)) throw new Error("unexpected token");
  c.i++;
  return { t: "lit", s: ch };
}

function parseClass(c: { s: string; i: number }): ReNode {
  c.i++; // consume [
  let negate = false;
  if (c.s[c.i] === "^") (negate = true), c.i++;
  const chars: string[] = [];
  while (c.i < c.s.length && c.s[c.i] !== "]") {
    let lo: string;
    if (c.s[c.i] === "\\") {
      const esc = classEscape(c.s[c.i + 1]);
      c.i += 2;
      if (esc) {
        chars.push(...esc);
        continue;
      }
      lo = c.s[c.i - 1];
    } else {
      lo = c.s[c.i++];
    }
    if (c.s[c.i] === "-" && c.s[c.i + 1] !== "]" && c.i + 1 < c.s.length) {
      const hi = c.s[c.i + 1];
      c.i += 2;
      chars.push(...expandRange(lo, hi));
    } else {
      chars.push(lo);
    }
  }
  if (c.s[c.i] !== "]") throw new Error("unterminated class");
  c.i++;
  if (negate) {
    const base = new Set([...expandRange("a", "z"), ...expandRange("A", "Z"), ...expandRange("0", "9")]);
    for (const ch of chars) base.delete(ch);
    return { t: "class", chars: [...base] };
  }
  return { t: "class", chars };
}

function parseEscape(c: { s: string; i: number }): ReNode {
  const next = c.s[c.i + 1];
  c.i += 2;
  const cls = classEscape(next);
  if (cls) return { t: "class", chars: cls };
  if (next === undefined) throw new Error("trailing backslash");
  return { t: "lit", s: next };
}

/** Character set for a class shorthand (`\d`, `\w`, `\s`), or null for a literal escape. */
function classEscape(ch: string | undefined): string[] | null {
  if (ch === "d") return expandRange("0", "9");
  if (ch === "w") return [...expandRange("a", "z"), ...expandRange("A", "Z"), ...expandRange("0", "9"), "_"];
  if (ch === "s") return [" "];
  return null;
}

function expandRange(lo: string, hi: string): string[] {
  const out: string[] = [];
  for (let cc = lo.charCodeAt(0); cc <= hi.charCodeAt(0); cc++) out.push(String.fromCharCode(cc));
  return out;
}

function emitNode(node: ReNode, f: Faker): string {
  switch (node.t) {
    case "seq":
      return node.items.map((n) => emitNode(n, f)).join("");
    case "alt":
      return emitNode(f.helpers.arrayElement(node.opts), f);
    case "rep": {
      const n = f.number.int({ min: node.min, max: Math.max(node.min, node.max) });
      let s = "";
      for (let k = 0; k < n; k++) s += emitNode(node.node, f);
      return s;
    }
    case "class":
      return node.chars.length ? f.helpers.arrayElement(node.chars) : "";
    case "lit":
      return node.s;
  }
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

/**
 * A generator that keeps a partition-key column's value inside a partition that
 * actually exists, so the parent-table insert routes successfully. Returns null
 * when no constraint is needed or we can't derive one (a DEFAULT partition
 * exists, hash partitioning, an expression key, or unparseable bounds) — the
 * caller then falls back to the ordinary generator.
 */
export function partitionKeyGenerator(col: ColumnInfo, part: PartitionInfo): Generator | null {
  // Only the first key column drives routing here; DEFAULT/hash/expression keys
  // accept any value, so no constraint is required.
  if (part.hasDefault || part.strategy === "hash") return null;
  if (part.keyColumns[0] !== col.name) return null;

  if (part.strategy === "list") {
    const values = (part.list ?? []).map((v) => coerce(v, col));
    if (values.length === 0) return null;
    return (f) => f.helpers.arrayElement(values);
  }

  const ranges = (part.ranges ?? []).filter((r) => r.from !== null || r.to !== null);
  if (ranges.length === 0) return null;
  return (f) => {
    const r = f.helpers.arrayElement(ranges);
    return valueInRange(r.from, r.to, col, f);
  };
}

/** Coerce a raw bound/list literal string to the column's JS value type. */
function coerce(raw: string, col: ColumnInfo): unknown {
  if (col.dataType === "integer" || col.dataType === "decimal") return Number(raw);
  if (col.dataType === "boolean") return /^(t|true|1)$/i.test(raw);
  return raw;
}

const RANGE_SPAN_MS = 1000 * 60 * 60 * 24 * 365; // ~1y fallback for open-ended time ranges
const RANGE_SPAN_NUM = 1000;

/** Generate a value within [from, to) for a RANGE partition, typed by column. */
function valueInRange(from: string | null, to: string | null, col: ColumnInfo, f: Faker): unknown {
  const cat = col.dataType;
  if (cat === "timestamp" || cat === "date") {
    const lo = from !== null ? new Date(from).getTime() : new Date(to!).getTime() - RANGE_SPAN_MS;
    const hi = to !== null ? new Date(to!).getTime() : new Date(from!).getTime() + RANGE_SPAN_MS;
    const d = new Date(f.number.int({ min: lo, max: Math.max(lo, hi - 1) }));
    return cat === "date" ? d.toISOString().slice(0, 10) : d;
  }
  if (cat === "integer" || cat === "decimal") {
    const lo = from !== null ? Number(from) : Number(to) - RANGE_SPAN_NUM;
    const hi = to !== null ? Number(to) : Number(from) + RANGE_SPAN_NUM;
    if (cat === "integer") return f.number.int({ min: Math.ceil(lo), max: Math.max(Math.ceil(lo), Math.floor(hi) - 1) });
    return f.number.float({ min: lo, max: Math.max(lo, hi), fractionDigits: Math.min(col.numericScale ?? 2, 6) });
  }
  // Text (or anything else) partitioned by range: the inclusive lower bound is a
  // valid, in-partition value — good enough without inventing an ordering.
  return from ?? to;
}

/** Coarse guard so name heuristics don't violate the column's actual type. */
function isCompatible(col: ColumnInfo): boolean {
  // Name rules produce plain strings/dates, so only apply them to columns that
  // can actually hold one. Structured (array/composite/range/json), binary
  // (bytea), network (inet), and scalar-only (numeric/boolean/uuid) types all
  // fall through to their type-specific generator instead.
  return ["text", "date", "time", "timestamp"].includes(col.dataType);
}
