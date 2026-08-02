#!/usr/bin/env node
/** seedcoherent — schema-aware synthetic data generator for Postgres, MySQL, and SQLite. */

import { readFile, writeFile } from "node:fs/promises";
import { Command } from "commander";
import { loadConfig, parseColumnSpecs, parseDistSpecs, parseRowSpecs } from "./config.js";
import { dialectByName, dialectFor, type DialectName } from "./dialect.js";
import { loadSchemaFromDdl } from "./schema-file.js";
import { appendTargets, planAppend } from "./append.js";
import {
  buildData,
  generateInto,
  requiredUnsupportedColumns,
  rowCount,
  type AppendContext,
  type TableStats,
} from "./generate.js";
import { topoSort } from "./graph.js";
import { buildAppendPlan, buildPlan, buildSubsetPlan, formatPlan } from "./plan.js";
import { anonymizeAll, collectSubset } from "./subset.js";
import { temporalWindow } from "./temporal.js";
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
  .option("--since <date>", "earliest creation timestamp (ISO date), e.g. 2023-01-01")
  .option("--until <date>", "latest creation timestamp (ISO date); defaults to the seed reference date / now")
  .option("--batch-size <n>", "rows per COPY batch (default 10000)", (v) => parseInt(v, 10))
  .option(
    "--schema <name...>",
    "schema(s)/database(s) to read (default: public on Postgres / the MySQL database / main on SQLite)",
  )
  .option("--skip <table...>", "tables to leave empty", [])
  .option(
    "--distribution <spec...>",
    "skew a column: FK fan-out (orders.user_id=zipf), or a value column's labels (orders.status=zipf, orders.status=weighted:paid=0.9,refunded=0.1)",
    [],
  )
  .option(
    "-C, --column <spec...>",
    "override a column's generator: users.email=internet.email, status=values:active,inactive, or tier=value:gold",
    [],
  )
  .option("-c, --config <path>", "path to a config file")
  .option(
    "--schema-file <path>",
    "read the schema from a .sql/DDL file instead of a live database (no connection needed; requires -o/--print)",
  )
  .option(
    "--dialect <name>",
    "engine for --schema-file: parses that DDL grammar and emits that SQL flavor — postgres (default), mysql, or sqlite",
  )
  .option(
    "--schema-dialect <name>",
    "override the input DDL grammar alone (defaults to --dialect), to translate one engine's schema into another's seed SQL",
  )
  .option("-o, --out <file>", "write SQL to a file instead of inserting")
  .option("--print", "print SQL to stdout instead of inserting")
  .option("--dry-run", "preview the plan (table order, row counts, sample rows) without writing")
  .option(
    "--append",
    "add rows to a database that already has data: only --rows tables are grown, their FKs reference existing rows, and synthetic ids continue past the current max",
  )
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
    const offline = !!opts.schemaFile;
    const connStr = connection ?? process.env.DATABASE_URL;
    if (!connStr && !offline) {
      program.error("No connection string. Pass one as an argument or set DATABASE_URL.");
    }

    const fileConfig = await loadConfig(opts.config);
    const config: Config = {
      ...fileConfig,
      rows: { ...fileConfig.rows, ...parseRowSpecs(opts.rows) },
      columns: { ...fileConfig.columns, ...parseColumnSpecs(opts.column) },
      defaultRows: opts.defaultRows ?? fileConfig.defaultRows,
      seed: opts.seed ?? fileConfig.seed,
      since: opts.since ?? fileConfig.since,
      until: opts.until ?? fileConfig.until,
      batchSize: opts.batchSize ?? fileConfig.batchSize,
      skip: [...(fileConfig.skip ?? []), ...opts.skip],
      distributions: { ...fileConfig.distributions, ...parseDistSpecs(opts.distribution) },
      anonymize: [...(fileConfig.anonymize ?? []), ...opts.anonymize],
      preserve: [...(fileConfig.preserve ?? []), ...opts.preserve],
    };

    // Validate the temporal window up front so a bad --since/--until fails
    // before we connect (the dry-run plan path never reaches streamData).
    try {
      temporalWindow(config);
    } catch (err) {
      program.error(err instanceof Error ? err.message : String(err));
    }

    // Offline mode: build the schema from a DDL file and emit SQL with no DB.
    // Only the file-output path makes sense here — append/subset/direct-insert
    // all need a live database — so those combinations are rejected up front.
    if (offline) {
      await runOffline(opts, config);
      return;
    }

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
      const isAppend = !!opts.append;
      if (isAppend && isSubset) {
        program.error("--append and --subset are separate modes; use one at a time.");
      }
      if (isAppend && opts.truncate) {
        program.error("--append adds rows to existing data; --truncate would delete it first.");
      }

      // Append grows only the tables named via --rows; nothing to do otherwise.
      let appendCtx: AppendContext | undefined;
      if (isAppend) {
        if (appendTargets(schema, config).size === 0) {
          program.error("--append needs at least one table to grow: pass --rows <table>=<n>.");
        }
        appendCtx = await planAppend(schema, order, config, dialect.createRowFetcher(client));
      }

      // Some column types have no safe generated literal. If a NOT NULL column
      // of such a type has no default/override and no FK to draw from, the INSERT
      // would fail mid-transaction — report it up front instead. Subset mode
      // passes real values through verbatim, so it's exempt.
      if (!isSubset) {
        const skipSet = new Set(config.skip ?? []);
        const genKeys = isAppend
          ? [...appendCtx!.generate]
          : order
              .filter((t) => !skipSet.has(t.name) && !skipSet.has(t.key) && rowCount(t, config) > 0)
              .map((t) => t.key);
        const unsupported = requiredUnsupportedColumns(schema, config, genKeys);
        if (unsupported.length > 0) {
          const lines = unsupported.map((c) => `  ${c.table}.${c.column} (${c.udtName})`);
          const first = unsupported[0];
          program.error(
            [
              `Can't generate a value for ${unsupported.length} NOT NULL column(s) of an unsupported type:`,
              ...lines,
              "",
              "Provide a value and re-run — e.g.:",
              `  --column ${first.table}.${first.column}=value:<literal>`,
              "(a faker path or values:a,b,c work too), or make the column nullable / give it a DB default.",
            ].join("\n"),
          );
        }
      }

      const batchSize: number | undefined = config.batchSize;
      const verb = isSubset ? "Subset" : isAppend ? "Appended" : "Generated";
      const subsetData = async () =>
        anonymizeAll(
          schema,
          order,
          await collectSubset(schema, parseRowSpecs(opts.subset), dialect.createRowFetcher(client)),
          config,
        );

      if (opts.dryRun) {
        if (isSubset) {
          // Reading (SELECT) the source is safe; nothing is written. The preview
          // shows the real closed-over counts and the actual anonymized values.
          console.error(formatPlan(buildSubsetPlan(await subsetData(), cyclic), { subset: true }));
        } else if (isAppend) {
          // Existing rows were read (SELECT) to build the FK pools; nothing written.
          console.error(
            formatPlan(buildAppendPlan(schema, order, cyclic, config, appendCtx!), { append: true }),
          );
        } else {
          console.error(formatPlan(buildPlan(schema, order, cyclic, config)));
        }
        return;
      }

      if (opts.out || opts.print) {
        // SQL emit needs the full dataset in memory to assemble the script.
        const data = isSubset
          ? await subsetData()
          : buildData(schema, order, cyclic, config, appendCtx);
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
        // Direct insert (from-scratch or append): stream generation straight into
        // the sink so we never hold the whole dataset in memory. Append writes only
        // the grown tables and never truncates.
        const skip = new Set(config.skip ?? []);
        const tables = order.filter(
          (t) =>
            !skip.has(t.name) &&
            !skip.has(t.key) &&
            (!appendCtx || appendCtx.generate.has(t.key)),
        );
        const sink = dialect.createSink(client, {
          truncate: isAppend ? false : opts.truncate,
          tables,
          batchSize,
        });
        const stats = await generateInto(schema, order, cyclic, config, sink, batchSize, appendCtx);
        const filled = stats.filter((s) => s.rows > 0);
        console.error(summary(counts(stats), cyclic, verb));
        console.error(`\n✓ Inserted ${sink.inserted} rows across ${filled.length} tables`);
      }
    } finally {
      await client.end();
    }
  });

/**
 * `--schema-file` path: parse a DDL file into a Schema and emit generated SQL
 * without ever touching a database. Rejects the modes that inherently need a
 * live connection (append, subset, direct insert into `--to`/the source).
 */
async function runOffline(opts: any, config: Config): Promise<void> {
  if (opts.append) program.error("--append needs a live database; it can't run against --schema-file.");
  if (opts.subset.length > 0) program.error("--subset needs a live database; it can't run against --schema-file.");
  if (opts.to) program.error("--to needs a live database; it can't run against --schema-file.");
  if (opts.truncate) program.error("--truncate needs a live database; it has no effect with --schema-file.");

  // `--dialect` picks the engine for schema-file mode: it selects both the DDL
  // grammar to parse and the SQL flavor to emit. `--schema-dialect` overrides the
  // input grammar alone, for the rarer case of translating one engine's schema
  // into another's seed SQL (e.g. read Postgres DDL, emit MySQL).
  const outputDialect: DialectName = (opts.dialect ?? "postgres") as DialectName;
  if (!["postgres", "mysql", "sqlite"].includes(outputDialect)) {
    program.error(`Unknown --dialect '${opts.dialect}'. Use postgres, mysql, or sqlite.`);
  }
  const schemaDialect: DialectName = (opts.schemaDialect ?? outputDialect) as DialectName;
  if (!["postgres", "mysql", "sqlite"].includes(schemaDialect)) {
    program.error(`Unknown --schema-dialect '${opts.schemaDialect}'. Use postgres, mysql, or sqlite.`);
  }
  const dialect = dialectByName(outputDialect);

  let ddl: string;
  try {
    ddl = await readFile(opts.schemaFile, "utf8");
  } catch (err) {
    return program.error(`Can't read --schema-file ${opts.schemaFile}: ${err instanceof Error ? err.message : err}`);
  }

  const schema = loadSchemaFromDdl(ddl, schemaDialect);
  if (schema.tables.size === 0) {
    program.error(`No CREATE TABLE statements found in ${opts.schemaFile}.`);
  }
  const { order, cyclic } = topoSort(schema);

  // Same up-front guard the live path uses: a required column of a type we can't
  // synthesize would produce SQL the target database rejects, so flag it now.
  const skipSet = new Set(config.skip ?? []);
  const genKeys = order
    .filter((t) => !skipSet.has(t.name) && !skipSet.has(t.key) && rowCount(t, config) > 0)
    .map((t) => t.key);
  const unsupported = requiredUnsupportedColumns(schema, config, genKeys);
  if (unsupported.length > 0) {
    const lines = unsupported.map((c) => `  ${c.table}.${c.column} (${c.udtName})`);
    const first = unsupported[0];
    program.error(
      [
        `Can't generate a value for ${unsupported.length} NOT NULL column(s) of an unsupported type:`,
        ...lines,
        "",
        "Provide a value and re-run — e.g.:",
        `  --column ${first.table}.${first.column}=value:<literal>`,
        "(a faker path or values:a,b,c work too), or make the column nullable / give it a DB default.",
      ].join("\n"),
    );
  }

  if (opts.dryRun) {
    console.error(formatPlan(buildPlan(schema, order, cyclic, config)));
    return;
  }

  if (!opts.out && !opts.print) {
    program.error("--schema-file has no database to write to: pass -o <file>, --print, or --dry-run.");
  }

  const data = buildData(schema, order, cyclic, config);
  const totalRows = data.reduce((n, d) => n + d.rows.length, 0);
  const sql = dialect.toScript(data);
  if (opts.out) {
    await writeFile(opts.out, sql, "utf8");
    console.error(summary(counts(data), cyclic, "Generated"));
    console.error(`\n✓ Wrote ${totalRows} rows across ${data.length} tables to ${opts.out}`);
  } else {
    process.stdout.write(sql + "\n");
  }
}

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
