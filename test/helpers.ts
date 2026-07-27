/** Test helpers: build in-memory Schema/Table/Column objects without a live DB. */

import { categorize } from "../src/introspect.js";
import type { CheckConstraint, ColumnInfo, ForeignKey, Schema, TableInfo } from "../src/types.js";

export interface ColOpts extends Partial<Omit<ColumnInfo, "name">> {}

/** Build a ColumnInfo with sensible defaults; udtName drives dataType unless set. */
export function col(name: string, opts: ColOpts = {}): ColumnInfo {
  const udtName = opts.udtName ?? "text";
  const enumValues = opts.enumValues ?? null;
  return {
    name,
    udtName,
    dataType: opts.dataType ?? categorize(udtName, enumValues),
    elementType: opts.elementType,
    compositeFields: opts.compositeFields,
    rangeSubtype: opts.rangeSubtype,
    nullable: opts.nullable ?? false,
    hasDefault: opts.hasDefault ?? false,
    defaultExpr: opts.defaultExpr ?? null,
    isIdentity: opts.isIdentity ?? false,
    isGenerated: opts.isGenerated ?? false,
    maxLength: opts.maxLength ?? null,
    enumValues,
    numericPrecision: opts.numericPrecision ?? null,
    numericScale: opts.numericScale ?? null,
  };
}

/** A single-column integer identity PK column named `id`. */
export function idCol(): ColumnInfo {
  return col("id", { udtName: "int4", isIdentity: true });
}

export interface TableOpts {
  schema?: string;
  columns: ColumnInfo[];
  primaryKey?: string[];
  uniques?: string[][];
  foreignKeys?: ForeignKey[];
  checks?: CheckConstraint[];
}

export function table(name: string, opts: TableOpts): TableInfo {
  const schemaName = opts.schema ?? "public";
  return {
    schema: schemaName,
    name,
    key: `${schemaName}.${name}`,
    columns: opts.columns,
    primaryKey: opts.primaryKey ?? [],
    uniques: opts.uniques ?? [],
    foreignKeys: opts.foreignKeys ?? [],
    checks: opts.checks ?? [],
  };
}

/** Foreign key referencing `public.<refTable>`; single or composite. */
export function fk(columns: string[], refTable: string, refColumns: string[]): ForeignKey {
  return { columns, refTable: `public.${refTable}`, refColumns };
}

export function schema(...tables: TableInfo[]): Schema {
  return { tables: new Map(tables.map((t) => [t.key, t])) };
}
