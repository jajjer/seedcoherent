/** Loads an optional config file and merges CLI overrides into it. */

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { Config, ColumnOverride, DistSpec } from "./types.js";

const DEFAULT_NAMES = ["seed.config.json", "seed.config.js", "seed.config.mjs"];

/** Rows per COPY batch / streaming-generation chunk. */
export const DEFAULT_BATCH_SIZE = 10000;

export async function loadConfig(explicitPath?: string): Promise<Config> {
  const candidates = explicitPath ? [explicitPath] : DEFAULT_NAMES;
  for (const name of candidates) {
    const path = resolve(process.cwd(), name);
    try {
      if (name.endsWith(".json")) {
        const text = await readFile(path, "utf8");
        return JSON.parse(text) as Config;
      }
      const mod = await import(pathToFileURL(path).href);
      return (mod.default ?? mod) as Config;
    } catch (err: any) {
      if (err?.code === "ENOENT" || err?.code === "ERR_MODULE_NOT_FOUND") {
        if (explicitPath) throw new Error(`Config file not found: ${explicitPath}`);
        continue; // try next default name
      }
      throw err;
    }
  }
  return {};
}

/** Parse repeated `table=count` CLI flags into a rows map. */
export function parseRowSpecs(specs: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const spec of specs) {
    const eq = spec.lastIndexOf("=");
    if (eq === -1) throw new Error(`Invalid --rows spec "${spec}" (expected table=count)`);
    const table = spec.slice(0, eq).trim();
    const count = Number(spec.slice(eq + 1));
    if (!Number.isFinite(count) || count < 0) throw new Error(`Invalid row count in "${spec}"`);
    out[table] = Math.floor(count);
  }
  return out;
}

/**
 * Parse repeated `column=kind[:arg]` CLI flags into a distributions map. The
 * recognized kinds are:
 *   - `uniform` — even spread (the default); takes no argument.
 *   - `zipf[:skew]` — power-law over the choices in declared order; optional
 *     skew factor (`zipf:2` concentrates harder).
 *   - `weighted:v1=w1,v2=w2,...` — explicit relative weights per value, for a
 *     categorical value column, e.g. `orders.status=weighted:paid=0.9,refunded=0.1`.
 *     Weights need not sum to 1; values are JSON-coerced (so `1=…`,`true=…` land
 *     as a number/boolean), else kept as the raw string.
 */
export function parseDistSpecs(specs: string[]): Record<string, DistSpec> {
  const out: Record<string, DistSpec> = {};
  for (const spec of specs) {
    const eq = spec.indexOf("=");
    if (eq === -1) throw new Error(`Invalid --distribution spec "${spec}" (expected column=kind)`);
    const column = spec.slice(0, eq).trim();
    const rhs = spec.slice(eq + 1);
    // Split off the kind; `weighted:` keeps its whole `v=w,...` body as the arg.
    const colon = rhs.indexOf(":");
    const kind = colon === -1 ? rhs : rhs.slice(0, colon);
    const arg = colon === -1 ? undefined : rhs.slice(colon + 1);
    if (kind === "uniform") {
      if (arg !== undefined) throw new Error(`uniform takes no argument in "${spec}"`);
      out[column] = "uniform";
    } else if (kind === "zipf") {
      if (arg === undefined) {
        out[column] = "zipf";
      } else {
        const skew = Number(arg);
        if (!Number.isFinite(skew) || skew <= 0) throw new Error(`Invalid skew in "${spec}" (need > 0)`);
        out[column] = { kind: "zipf", skew };
      }
    } else if (kind === "weighted") {
      out[column] = { kind: "weighted", weights: parseWeights(arg, spec) };
    } else {
      throw new Error(`Unknown distribution "${kind}" in "${spec}" (use uniform, zipf, or weighted)`);
    }
  }
  return out;
}

/** Parse a `weighted:` body — `v1=w1,v2=w2,...` — into value/weight pairs. */
function parseWeights(body: string | undefined, spec: string): Array<{ value: unknown; weight: number }> {
  if (!body) throw new Error(`weighted needs value=weight pairs in "${spec}" (e.g. weighted:a=0.9,b=0.1)`);
  const pairs = body.split(",").map((s) => s.trim()).filter(Boolean);
  if (pairs.length === 0) throw new Error(`Empty weights in "${spec}" (expected weighted:a=0.9,b=0.1)`);
  const weights = pairs.map((pair) => {
    const eq = pair.lastIndexOf("=");
    if (eq === -1) throw new Error(`Invalid weight "${pair}" in "${spec}" (expected value=weight)`);
    const value = coerceLiteral(pair.slice(0, eq).trim());
    const weight = Number(pair.slice(eq + 1));
    if (!Number.isFinite(weight) || weight <= 0) throw new Error(`Invalid weight for "${pair}" in "${spec}" (need > 0)`);
    return { value, weight };
  });
  return weights;
}

/** Coerce a CLI literal token to JSON if it parses (numbers, booleans, null), else keep the raw string. */
function coerceLiteral(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Parse repeated `--link` CLI flags into groups of column patterns that share
 * one anonymization mapping. Each flag value is a single group, its columns
 * joined by `=`, e.g. `users.email=orders.customer_email`. A one-column group
 * is allowed (it's a harmless no-op) but an empty one is rejected.
 */
export function parseLinkGroups(specs: string[]): string[][] {
  const out: string[][] = [];
  for (const spec of specs) {
    const cols = spec.split("=").map((s) => s.trim()).filter(Boolean);
    if (cols.length === 0) throw new Error(`Invalid --link group "${spec}" (expected a=b[=c...])`);
    out.push(cols);
  }
  return out;
}

/**
 * Parse repeated `column=generator` CLI flags into a per-column override map,
 * mirroring the config file's `columns` field. The right-hand side is one of:
 *   - a faker path, e.g. `users.email=internet.email` → resolve that generator
 *   - `value:<literal>`, e.g. `tier=value:gold` → the constant value every row
 *   - `values:<a,b,c>`, e.g. `status=values:active,inactive` → pick uniformly
 * `value:`/`values:` tokens are JSON-coerced (`value:30` → 30, `value:true` →
 * true), falling back to the raw string. Keyed by "table.column",
 * "schema.table.column", or bare "column" — same forms as name inference.
 */
export function parseColumnSpecs(specs: string[]): Record<string, ColumnOverride> {
  const out: Record<string, ColumnOverride> = {};
  for (const spec of specs) {
    // Split on the first '=': the column key never contains '=', but a literal
    // value on the right-hand side might (e.g. value:a=b).
    const eq = spec.indexOf("=");
    if (eq === -1) throw new Error(`Invalid --column spec "${spec}" (expected column=generator)`);
    const column = spec.slice(0, eq).trim();
    const rhs = spec.slice(eq + 1);
    if (!column) throw new Error(`Invalid --column spec "${spec}" (empty column)`);
    if (!rhs) throw new Error(`Invalid --column spec "${spec}" (empty generator)`);

    if (rhs.startsWith("value:")) {
      out[column] = { value: coerceLiteral(rhs.slice("value:".length)) };
    } else if (rhs.startsWith("values:")) {
      const items = rhs.slice("values:".length).split(",").map((s) => s.trim());
      if (items.length === 0 || (items.length === 1 && items[0] === "")) {
        throw new Error(`Empty values list in "${spec}" (expected values:a,b,c)`);
      }
      out[column] = { values: items.map(coerceLiteral) };
    } else {
      out[column] = rhs; // a faker path like "internet.email"
    }
  }
  return out;
}
