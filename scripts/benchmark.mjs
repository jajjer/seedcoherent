#!/usr/bin/env node
/**
 * Throughput benchmark: generate + insert a configurable number of rows across
 * the demo e-commerce schema (a 5-table FK graph) into a throwaway SQLite file
 * and report wall-clock time, rows/sec, and peak RSS.
 *
 *   node scripts/benchmark.mjs            # ~1.1M rows
 *   node scripts/benchmark.mjs --scale 5  # 5x the row counts
 *
 * Requires a built dist/ (npm run build) and sqlite3 on PATH.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const scaleArg = process.argv.indexOf("--scale");
const scale = scaleArg !== -1 ? Number(process.argv[scaleArg + 1]) : 1;
if (!Number.isFinite(scale) || scale <= 0) {
  console.error("--scale must be a positive number");
  process.exit(1);
}

const base = { users: 100_000, products: 20_000, orders: 500_000, order_items: 500_000, categories: 500 };
const rows = Object.fromEntries(Object.entries(base).map(([t, n]) => [t, Math.round(n * scale)]));
const totalPlanned = Object.values(rows).reduce((a, b) => a + b, 0);

const dir = mkdtempSync(join(tmpdir(), "seedcoherent-bench-"));
const db = join(dir, "bench.db");

try {
  execFileSync("sqlite3", [db], {
    input: readSchema(),
    stdio: ["pipe", "ignore", "inherit"],
  });

  const rowArgs = Object.entries(rows).flatMap(([t, n]) => [`${t}=${n}`]);
  const start = process.hrtime.bigint();
  const out = execFileSync(
    process.execPath,
    [join(root, "dist/cli.js"), db, "--seed", "1", "--rows", ...rowArgs],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

  const inserted = Number(/Inserted (\d+) rows/.exec(out)?.[1] ?? totalPlanned);
  const perSec = Math.round(inserted / (elapsedMs / 1000));
  console.log(`\nBenchmark (scale ${scale})`);
  console.log(`  rows inserted : ${inserted.toLocaleString()}`);
  console.log(`  wall time     : ${(elapsedMs / 1000).toFixed(2)} s`);
  console.log(`  throughput    : ${perSec.toLocaleString()} rows/sec`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

function readSchema() {
  return execFileSync("cat", [join(root, "examples/demo-sqlite.sql")], { encoding: "utf8" });
}
