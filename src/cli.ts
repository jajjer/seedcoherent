#!/usr/bin/env node
/** seedcoherent — schema-aware synthetic data generator for Postgres, MySQL, and SQLite. */

import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import { loadConfig, parseDistSpecs, parseRowSpecs } from "./config.js";
import { dialectFor } from "./dialect.js";
import { buildData, generateInto, type TableStats } from "./generate.js";
import { topoSort } from "./graph.js";
import { anonymizeAll, collectSubset } from "./subset.js";
import type { Config, TableInfo } from "./types.js";

const program = new Command();

program
  .name("seedcoherent")
  .description(
    "Point it at your Postgres, MySQL, or SQLite schema, get coherent, referentially-correct fake data.",
  )
  .argument("[connection]", "Postgres/MySQL/SQLite connection string or SQLite file path (or set DATABASE_URL)")
  .option("-r, --rows <spec...>", "rows per table, e.g. users=1000 orders=5000", [])
  .option("-d, --default-rows <n>", "default rows for tables not listed", (v) => parseInt(v, 10))
  .option("-s, --seed <n>", "RNG seed for deterministic output", (v) => parseInt(v, 10))
  .option("--batch-size <n>", "rows per COPY batch (default 10000)", (v) => parseInt(v, 10))
  .option(
    "--schema <name...>",
    "schema(s)/database(s) to read (default: public on Postgres / the MySQL database / main on SQLite)",
  )
  .option("--skip <table...>", "tables to leave empty", [])
  .option(
    "--distribution <spec...>",
    "FK fan-out per child column, e.g. orders.user_id=zipf or orders.user_id=zipf:2 (default uniform)",
    [],
  )
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
      batchSize: opts.batchSize ?? fileConfig.batchSize,
      skip: [...(fileConfig.skip ?? []), ...opts.skip],
      distributions: { ...fileConfig.distributions, ...parseDistSpecs(opts.distribution) },
      anonymize: [...(fileConfig.anonymize ?? []), ...opts.anonymize],
      preserve: [...(fileConfig.preserve ?? []), ...opts.preserve],
    };

    const dialect = dialectFor(connStr);
    const schemas: string[] = opts.schema ?? dialect.defaultSchemas(connStr);
    const client = await dialect.connect(connStr);
    try {
      const schema = await dialect.introspect(client, schemas);
      if (schema.tables.size === 0) {
        program.error(`No tables found in schema(s): ${schemas.join(", ") || "(none)"}`);
      }
      const { order, cyclic } = topoSort(schema);

      const isSubset = opts.subset.length > 0;
      const batchSize: number | undefined = config.batchSize;
      const verb = isSubset ? "Subset" : "Generated";
      const subsetData = async () =>
        anonymizeAll(
          schema,
          order,
          await collectSubset(schema, parseRowSpecs(opts.subset), dialect.createRowFetcher(client)),
          config,
        );

      if (opts.out || opts.print) {
        // SQL emit needs the full dataset in memory to assemble the script.
        const data = isSubset ? await subsetData() : buildData(schema, order, cyclic, config);
        const totalRows = data.reduce((n, d) => n + d.rows.length, 0);
        const sql = dialect.toScript(data);
        if (opts.out) {
          await writeFile(opts.out, sql, "utf8");
          console.error(summary(counts(data), cyclic, verb));
          console.error(`\n✓ Wrote ${totalRows} rows across ${data.length} tables to ${opts.out}`);
        } else {
          process.stdout.write(sql + "\n");
        }
      } else if (isSubset) {
        // Never write anonymized rows back into the source; require an explicit target.
        if (!opts.to) {
          program.error("--subset needs a destination: pass --to <connection>, --out <file>, or --print.");
        }
        const data = await subsetData();
        const targetDialect = dialectFor(opts.to);
        const target = await targetDialect.connect(opts.to);
        try {
          const inserted = await targetDialect.insertData(target, data, {
            truncate: opts.truncate,
            batchSize,
          });
          console.error(summary(counts(data), cyclic, verb));
          console.error(`\n✓ Inserted ${inserted} rows across ${data.length} tables into --to target`);
        } finally {
          await target.end();
        }
      } else {
        // From-scratch direct insert: stream generation straight into the sink so
        // we never hold the whole dataset in memory.
        const skip = new Set(config.skip ?? []);
        const tables = order.filter((t) => !skip.has(t.name) && !skip.has(t.key));
        const sink = dialect.createSink(client, { truncate: opts.truncate, tables, batchSize });
        const stats = await generateInto(schema, order, cyclic, config, sink, batchSize);
        const filled = stats.filter((s) => s.rows > 0);
        console.error(summary(counts(stats), cyclic, verb));
        console.error(`\n✓ Inserted ${sink.inserted} rows across ${filled.length} tables`);
      }
    } finally {
      await client.end();
    }
  });

/** Normalize either materialized TableData or streaming stats into name/count pairs. */
function counts(
  entries: ({ table: TableInfo; rows: unknown[] } | TableStats)[],
): { key: string; count: number }[] {
  return entries.map((e) => ({
    key: e.table.key,
    count: typeof e.rows === "number" ? e.rows : e.rows.length,
  }));
}

function summary(
  entries: { key: string; count: number }[],
  cyclic: Set<string>,
  verb = "Generated",
): string {
  const lines = entries
    .filter((e) => e.count > 0)
    .map((e) => {
      const mark = cyclic.has(e.key) ? " (cyclic)" : "";
      return `  ${e.key.padEnd(32)} ${String(e.count).padStart(7)}${mark}`;
    });
  return [`${verb}:`, ...lines].join("\n");
}

program.parseAsync().catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
