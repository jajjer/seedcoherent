#!/usr/bin/env node
/** seedcoherent — schema-aware synthetic data generator for Postgres. */

import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import pg from "pg";
import { loadConfig, parseRowSpecs } from "./config.js";
import { toSql, insertInto } from "./emit.js";
import { buildData } from "./generate.js";
import { topoSort } from "./graph.js";
import { introspect } from "./introspect.js";
import { anonymizeAll, collectSubset, PgRowFetcher } from "./subset.js";
import type { Config } from "./types.js";

const program = new Command();

program
  .name("seedcoherent")
  .description("Point it at your Postgres schema, get coherent, referentially-correct fake data.")
  .argument("[connection]", "Postgres connection string (or set DATABASE_URL)")
  .option("-r, --rows <spec...>", "rows per table, e.g. users=1000 orders=5000", [])
  .option("-d, --default-rows <n>", "default rows for tables not listed", (v) => parseInt(v, 10))
  .option("-s, --seed <n>", "RNG seed for deterministic output", (v) => parseInt(v, 10))
  .option("--schema <name...>", "schema(s) to read", ["public"])
  .option("--skip <table...>", "tables to leave empty", [])
  .option("-c, --config <path>", "path to a config file")
  .option("-o, --out <file>", "write SQL to a file instead of inserting")
  .option("--print", "print SQL to stdout instead of inserting")
  .option("--truncate", "TRUNCATE target tables before inserting")
  .option(
    "--subset <spec...>",
    "subset+anonymize real data: seed rows per root table, e.g. orders=500 users=100",
    [],
  )
  .option("--to <connection>", "target DB to insert the anonymized subset into")
  .option(
    "--anonymize <col...>",
    "subset: also scrub these join keys, e.g. accounts.email (remaps the whole join)",
    [],
  )
  .option("--preserve <col...>", "subset: keep these columns' real values, e.g. users.country", [])
  .action(async (connection, opts) => {
    const connStr = connection ?? process.env.DATABASE_URL;
    if (!connStr) {
      program.error("No connection string. Pass one as an argument or set DATABASE_URL.");
    }

    const fileConfig = await loadConfig(opts.config);
    const config: Config = {
      ...fileConfig,
      rows: { ...fileConfig.rows, ...parseRowSpecs(opts.rows) },
      defaultRows: opts.defaultRows ?? fileConfig.defaultRows,
      seed: opts.seed ?? fileConfig.seed,
      skip: [...(fileConfig.skip ?? []), ...opts.skip],
      anonymize: [...(fileConfig.anonymize ?? []), ...opts.anonymize],
      preserve: [...(fileConfig.preserve ?? []), ...opts.preserve],
    };

    const client = new pg.Client({ connectionString: connStr });
    await client.connect();
    try {
      const schema = await introspect(client, opts.schema);
      if (schema.tables.size === 0) {
        program.error(`No tables found in schema(s): ${opts.schema.join(", ")}`);
      }
      const { order, cyclic } = topoSort(schema);

      const isSubset = opts.subset.length > 0;
      const data = isSubset
        ? anonymizeAll(schema, order, await collectSubset(schema, parseRowSpecs(opts.subset), new PgRowFetcher(client)), config)
        : buildData(schema, order, cyclic, config);

      const totalRows = data.reduce((n, d) => n + d.rows.length, 0);
      const verb = isSubset ? "Subset" : "Generated";

      if (opts.out || opts.print) {
        const sql = toSql(data);
        if (opts.out) {
          await writeFile(opts.out, sql, "utf8");
          console.error(summary(data, cyclic, verb));
          console.error(`\n✓ Wrote ${totalRows} rows across ${data.length} tables to ${opts.out}`);
        } else {
          process.stdout.write(sql + "\n");
        }
      } else if (isSubset) {
        // Never write anonymized rows back into the source; require an explicit target.
        if (!opts.to) {
          program.error("--subset needs a destination: pass --to <connection>, --out <file>, or --print.");
        }
        const target = new pg.Client({ connectionString: opts.to });
        await target.connect();
        try {
          const inserted = await insertInto(target, data, opts.truncate);
          console.error(summary(data, cyclic, verb));
          console.error(`\n✓ Inserted ${inserted} rows across ${data.length} tables into --to target`);
        } finally {
          await target.end();
        }
      } else {
        const inserted = await insertInto(client, data, opts.truncate);
        console.error(summary(data, cyclic, verb));
        console.error(`\n✓ Inserted ${inserted} rows across ${data.length} tables`);
      }
    } finally {
      await client.end();
    }
  });

function summary(
  data: { table: { key: string }; rows: unknown[] }[],
  cyclic: Set<string>,
  verb = "Generated",
): string {
  const lines = data
    .filter((d) => d.rows.length > 0)
    .map((d) => {
      const mark = cyclic.has(d.table.key) ? " (cyclic)" : "";
      return `  ${d.table.key.padEnd(32)} ${String(d.rows.length).padStart(7)}${mark}`;
    });
  return [`${verb}:`, ...lines].join("\n");
}

program.parseAsync().catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
