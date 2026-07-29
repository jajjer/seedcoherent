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
 * Parse repeated `column=kind[:skew]` CLI flags into a distributions map, e.g.
 * `orders.user_id=zipf` or `orders.user_id=zipf:2`. `uniform` and `zipf` are the
 * recognized kinds; only `zipf` accepts an optional skew factor.
 */
export function parseDistSpecs(specs: string[]): Record<string, DistSpec> {
  const out: Record<string, DistSpec> = {};
  for (const spec of specs) {
    const eq = spec.lastIndexOf("=");
    if (eq === -1) throw new Error(`Invalid --distribution spec "${spec}" (expected column=kind)`);
    const column = spec.slice(0, eq).trim();
    const [kind, skewStr] = spec.slice(eq + 1).split(":");
    if (kind === "uniform") {
      if (skewStr !== undefined) throw new Error(`uniform takes no skew in "${spec}"`);
      out[column] = "uniform";
    } else if (kind === "zipf") {
      if (skewStr === undefined) {
        out[column] = "zipf";
      } else {
        const skew = Number(skewStr);
        if (!Number.isFinite(skew) || skew <= 0) throw new Error(`Invalid skew in "${spec}" (need > 0)`);
        out[column] = { kind: "zipf", skew };
      }
    } else {
      throw new Error(`Unknown distribution "${kind}" in "${spec}" (use uniform or zipf)`);
    }
  }
  return out;
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
