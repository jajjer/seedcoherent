/** Loads an optional config file and merges CLI overrides into it. */

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { Config } from "./types.js";

const DEFAULT_NAMES = ["seed.config.json", "seed.config.js", "seed.config.mjs"];

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
