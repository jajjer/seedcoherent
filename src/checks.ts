/**
 * Distills CHECK constraint expressions into per-column bounds that the
 * generator can honor, so we stop producing rows the database will reject
 * (`price > 0`, `status IN (...)`, `char_length(name) >= 3`, ...).
 *
 * Postgres normalizes check expressions when we read them back via
 * `pg_get_expr`, so this parser targets those normalized shapes:
 *   - comparisons:  (price > (0)::numeric), (age >= 0), (a <= 100)
 *   - membership:   ((status)::text = ANY (ARRAY['a'::text, 'b'::text]))
 *   - length:       (char_length((name)::text) >= 3)
 * Anything it can't confidently parse is skipped — leaving that column exactly
 * as unconstrained as it was before, never producing a wrong bound.
 */

import type { CheckConstraint, ColumnCheck } from "./types.js";

/** Build a column -> bounds map from a table's CHECK constraints. */
export function parseChecks(checks: CheckConstraint[]): Map<string, ColumnCheck> {
  const out = new Map<string, ColumnCheck>();
  for (const { expr } of checks) {
    // Postgres wraps the whole expression (and each conjunct) in parens; peel
    // the outer layer so top-level `AND` splitting sees depth 0.
    for (const clause of splitConjuncts(stripOuterParens(expr))) {
      const parsed = parseClause(clause);
      if (!parsed) continue;
      const [column, partial] = parsed;
      out.set(column, mergeCheck(out.get(column) ?? {}, partial));
    }
  }
  return out;
}

/** Split a top-level `A AND B AND C` expression into its conjuncts. */
function splitConjuncts(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && /\s/.test(ch)) {
      // Look for a top-level " AND " keyword.
      const rest = expr.slice(i).match(/^\s+AND\s+/i);
      if (rest) {
        parts.push(expr.slice(start, i));
        i += rest[0].length - 1;
        start = i + 1;
      }
    }
  }
  parts.push(expr.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

const COMPARATORS = [">=", "<=", "<>", "!=", ">", "<", "="] as const;

function parseClause(clause: string): [string, Partial<ColumnCheck>] | null {
  const inner = stripWrap(clause);
  return parseMembership(inner) ?? parseLength(inner) ?? parseComparison(inner);
}

/** `<expr> = ANY (ARRAY[lit, lit, ...])` — an IN-list restriction. */
function parseMembership(clause: string): [string, Partial<ColumnCheck>] | null {
  // Match the left operand and the opening `ARRAY[`, then find its matching
  // `]` — greedily matching to the last `]` would swallow a trailing `::text[]`.
  const m = clause.match(/^(.*?)=\s*ANY\s*\(\s*ARRAY\s*\[/is);
  if (!m) return null;
  const column = asColumn(m[1]);
  if (!column) return null;
  const open = m[0].length - 1; // index of '['
  const close = matchingBracket(clause, open);
  if (close === -1) return null;
  const values = splitTopLevel(clause.slice(open + 1, close)).map(parseLiteral);
  if (values.length === 0 || values.some((v) => v === null)) return null;
  return [column, { in: values as (string | number)[] }];
}

/** `char_length(col) <op> N` / `length(col) <op> N` — a length bound. */
function parseLength(clause: string): [string, Partial<ColumnCheck>] | null {
  const m = clause.match(
    /^(?:char_length|length|octet_length)\s*\((.*)\)\s*(>=|<=|>|<|=)\s*(.+)$/is,
  );
  if (!m) return null;
  const column = asColumn(m[1]);
  const n = asNumber(m[3]);
  if (!column || n === null) return null;
  const op = m[2];
  const partial: Partial<ColumnCheck> = {};
  if (op === "=") {
    partial.minLength = n;
    partial.maxLength = n;
  } else if (op === ">=") partial.minLength = n;
  else if (op === ">") partial.minLength = n + 1;
  else if (op === "<=") partial.maxLength = n;
  else if (op === "<") partial.maxLength = n - 1;
  return [column, partial];
}

/** `<col> <op> <number>` (either operand order) — a numeric range bound. */
function parseComparison(clause: string): [string, Partial<ColumnCheck>] | null {
  const split = splitOnComparator(clause);
  if (!split) return null;
  let [left, op, right] = split;

  let column = asColumn(left);
  let value = asNumber(right);
  if (column === null || value === null) {
    // Try the flipped orientation: `100 >= age`.
    const flippedCol = asColumn(right);
    const flippedVal = asNumber(left);
    if (flippedCol === null || flippedVal === null) return null;
    column = flippedCol;
    value = flippedVal;
    op = flip(op);
  }

  const partial: Partial<ColumnCheck> = {};
  switch (op) {
    case ">":
      partial.min = value;
      partial.minExclusive = true;
      break;
    case ">=":
      partial.min = value;
      partial.minExclusive = false;
      break;
    case "<":
      partial.max = value;
      partial.maxExclusive = true;
      break;
    case "<=":
      partial.max = value;
      partial.maxExclusive = false;
      break;
    case "=":
      partial.min = value;
      partial.max = value;
      partial.minExclusive = false;
      partial.maxExclusive = false;
      break;
    default: // <>, != — can't usefully bound a range
      return null;
  }
  return [column, partial];
}

/** Find the first top-level comparator and split around it. */
function splitOnComparator(clause: string): [string, string, string] | null {
  let depth = 0;
  for (let i = 0; i < clause.length; i++) {
    const ch = clause[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0) {
      for (const op of COMPARATORS) {
        if (clause.startsWith(op, i)) {
          return [clause.slice(0, i), op, clause.slice(i + op.length)];
        }
      }
    }
  }
  return null;
}

function flip(op: string): string {
  switch (op) {
    case ">":
      return "<";
    case ">=":
      return "<=";
    case "<":
      return ">";
    case "<=":
      return ">=";
    default:
      return op;
  }
}

/** Combine two partial bounds for the same column; tightest wins. */
function mergeCheck(a: ColumnCheck, b: Partial<ColumnCheck>): ColumnCheck {
  const out: ColumnCheck = { ...a };
  if (b.in) out.in = out.in ? out.in.filter((v) => b.in!.includes(v)) : b.in;
  if (b.min !== undefined && (out.min === undefined || b.min > out.min)) {
    out.min = b.min;
    out.minExclusive = b.minExclusive;
  }
  if (b.max !== undefined && (out.max === undefined || b.max < out.max)) {
    out.max = b.max;
    out.maxExclusive = b.maxExclusive;
  }
  if (b.minLength !== undefined) out.minLength = Math.max(out.minLength ?? 0, b.minLength);
  if (b.maxLength !== undefined) out.maxLength = Math.min(out.maxLength ?? Infinity, b.maxLength);
  return out;
}

// ---- literal / token helpers ----

/** Strip balanced outer parens and trailing `::type` casts, repeatedly. */
function stripWrap(s: string): string {
  let prev: string;
  do {
    prev = s;
    s = s.trim();
    if (s.startsWith("(") && matchingParen(s, 0) === s.length - 1) s = s.slice(1, -1);
    s = s.replace(/::\s*[a-zA-Z_][a-zA-Z0-9_ ]*(\s*\(\s*\d+\s*(,\s*\d+\s*)?\))?(\s*\[\s*\])?$/, "");
  } while (s !== prev);
  return s.trim();
}

/** Strip balanced outer parens (only) repeatedly — leaves casts intact. */
function stripOuterParens(s: string): string {
  s = s.trim();
  while (s.startsWith("(") && matchingParen(s, 0) === s.length - 1) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

/** Index of the `)` matching the `(` at `open`, or -1. */
function matchingParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Index of the `]` matching the `[` at `open`, or -1. */
function matchingBracket(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "[") depth++;
    else if (s[i] === "]" && --depth === 0) return i;
  }
  return -1;
}

/** Split a comma-separated list, respecting parens (for ARRAY[...] contents). */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Return the bare column name if `s` reduces to a single identifier. */
function asColumn(s: string): string | null {
  const t = stripWrap(s);
  return /^"?[a-zA-Z_][a-zA-Z0-9_]*"?$/.test(t) ? t.replace(/"/g, "") : null;
}

/** Return the numeric value if `s` reduces to a plain number literal. */
function asNumber(s: string): number | null {
  const t = stripWrap(s);
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
}

/** Parse a SQL literal (quoted string or number) into a JS value, or null. */
function parseLiteral(s: string): string | number | null {
  const t = stripCast(s.trim());
  const str = t.match(/^'((?:[^']|'')*)'$/);
  if (str) return str[1].replace(/''/g, "'");
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return null;
}

/** Remove a trailing `::type` cast from a single literal token. */
function stripCast(s: string): string {
  return s
    .replace(/::\s*[a-zA-Z_][a-zA-Z0-9_ ]*(\s*\(\s*\d+\s*(,\s*\d+\s*)?\))?(\s*\[\s*\])?$/, "")
    .trim();
}
