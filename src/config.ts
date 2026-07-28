/** Loads an optional config file and merges CLI overrides into it. */

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { Config, DistSpec } from "./types.js";

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
