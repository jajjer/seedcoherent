/**
 * Column-name matching primitives, shared by semantic inference (`infer.ts`)
 * and PII classification (`pii.ts`). Both decide what a column *is* from its
 * name, so they normalize and match names the same way.
 */

/** Normalize a column name for matching: lowercase, strip separators. */
export function norm(name: string): string {
  return name.toLowerCase().replace(/[_\s-]+/g, "");
}

/** Split into lowercased tokens across underscores/hyphens and camelCase. */
export function tokenize(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export interface MatchCtx {
  /** Whole-string, separators removed: "shippingcity". */
  n: string;
  /** Token list: ["shipping", "city"]. */
  tokens: string[];
}

/** Build the matching context for a column name. */
export function ctxFor(name: string): MatchCtx {
  return { n: norm(name), tokens: tokenize(name) };
}

/** Substring match on the joined name — for long, unambiguous fragments. */
export const has =
  (...frags: string[]) =>
  (c: MatchCtx) =>
    frags.some((f) => c.n.includes(f));
/** Whole-token match — for short/ambiguous fragments ("ip", "lat", "name"). */
export const tok =
  (...names: string[]) =>
  (c: MatchCtx) =>
    names.some((x) => c.tokens.includes(x));
/** Combine matchers: true if any matches. */
export const or =
  (...fns: Array<(c: MatchCtx) => boolean>) =>
  (c: MatchCtx) =>
    fns.some((fn) => fn(c));
