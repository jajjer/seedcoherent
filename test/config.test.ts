/** Tests for CLI row-spec parsing and config-file loading. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseRowSpecs } from "../src/config.js";

test("parseRowSpecs parses table=count pairs", () => {
  assert.deepEqual(parseRowSpecs(["users=1000", "orders=5000"]), {
    users: 1000,
    orders: 5000,
  });
});

test("parseRowSpecs floors non-integer counts", () => {
  assert.deepEqual(parseRowSpecs(["users=10.9"]), { users: 10 });
});

test("parseRowSpecs splits on the last '=' so schema-qualified names work", () => {
  assert.deepEqual(parseRowSpecs(["public.users=5"]), { "public.users": 5 });
});

test("parseRowSpecs rejects specs without '='", () => {
  assert.throws(() => parseRowSpecs(["users"]), /expected table=count/);
});

test("parseRowSpecs rejects non-numeric or negative counts", () => {
  assert.throws(() => parseRowSpecs(["users=abc"]), /Invalid row count/);
  assert.throws(() => parseRowSpecs(["users=-5"]), /Invalid row count/);
});

test("parseRowSpecs handles an empty list", () => {
  assert.deepEqual(parseRowSpecs([]), {});
});

test("loadConfig reads a JSON config from an explicit path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "seedcoherent-"));
  try {
    const path = join(dir, "custom.json");
    await writeFile(path, JSON.stringify({ defaultRows: 25, seed: 7 }), "utf8");
    const cfg = await loadConfig(path);
    assert.equal(cfg.defaultRows, 25);
    assert.equal(cfg.seed, 7);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig throws when an explicit path is missing", async () => {
  await assert.rejects(
    () => loadConfig(join(tmpdir(), "definitely-not-here-12345.json")),
    /Config file not found/,
  );
});

test("loadConfig returns {} when no default config file exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "seedcoherent-empty-"));
  const cwd = process.cwd();
  try {
    process.chdir(dir); // no seed.config.* here
    assert.deepEqual(await loadConfig(), {});
  } finally {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  }
});
