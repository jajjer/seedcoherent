/** Tests for CLI row-spec parsing and config-file loading. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseColumnSpecs, parseLinkGroups, parseRowSpecs } from "../src/config.js";

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

test("parseColumnSpecs treats a bare right-hand side as a faker path", () => {
  assert.deepEqual(parseColumnSpecs(["users.email=internet.email"]), {
    "users.email": "internet.email",
  });
});

test("parseColumnSpecs parses value: into a constant, coercing JSON literals", () => {
  assert.deepEqual(parseColumnSpecs(["tier=value:gold", "age=value:30", "active=value:true"]), {
    tier: { value: "gold" },
    age: { value: 30 },
    active: { value: true },
  });
});

test("parseColumnSpecs parses values: into a coerced pick list", () => {
  assert.deepEqual(parseColumnSpecs(["status=values:active,inactive", "n=values:1,2,3"]), {
    status: { values: ["active", "inactive"] },
    n: { values: [1, 2, 3] },
  });
});

test("parseColumnSpecs keeps a value: literal that itself contains '='", () => {
  assert.deepEqual(parseColumnSpecs(["cfg=value:a=b"]), { cfg: { value: "a=b" } });
});

test("parseColumnSpecs keys off the first '=', so schema-qualified names work", () => {
  assert.deepEqual(parseColumnSpecs(["public.users.email=internet.email"]), {
    "public.users.email": "internet.email",
  });
});

test("parseColumnSpecs rejects specs without '=', empty sides, and empty value lists", () => {
  assert.throws(() => parseColumnSpecs(["users.email"]), /expected column=generator/);
  assert.throws(() => parseColumnSpecs(["=internet.email"]), /empty column/);
  assert.throws(() => parseColumnSpecs(["users.email="]), /empty generator/);
  assert.throws(() => parseColumnSpecs(["status=values:"]), /Empty values list/);
});

test("parseColumnSpecs handles an empty list", () => {
  assert.deepEqual(parseColumnSpecs([]), {});
});

test("parseLinkGroups splits each flag value into a group on '='", () => {
  assert.deepEqual(
    parseLinkGroups(["users.email=orders.customer_email", "phone"]),
    [["users.email", "orders.customer_email"], ["phone"]],
  );
});

test("parseLinkGroups trims blanks and rejects an all-blank group", () => {
  assert.deepEqual(parseLinkGroups([" a = b "]), [["a", "b"]]);
  assert.throws(() => parseLinkGroups(["="]), /expected a=b/);
  assert.deepEqual(parseLinkGroups([]), []);
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
