/** Tests for PII classification (category + sensitivity) from column names. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyColumn, type PiiCategory } from "../src/pii.js";
import { col, table } from "./helpers.js";

/** Classify a standalone column by name. */
function classify(name: string) {
  const c = col(name);
  return classifyColumn(table("t", { columns: [c] }), c);
}

const CASES: Array<[string, PiiCategory]> = [
  ["ssn", "ssn"],
  ["social_security_number", "ssn"],
  ["tax_id", "tax_id"],
  ["ein", "tax_id"],
  ["vat_number", "tax_id"],
  ["passport_no", "passport"],
  ["drivers_license", "drivers_license"],
  ["license_number", "drivers_license"],
  ["national_id", "national_id"],
  ["bank_account_number", "bank_account"],
  ["routing_number", "routing_number"],
  ["credit_card", "credit_card"],
  ["iban", "iban"],
  ["password_hash", "password"],
  ["date_of_birth", "date_of_birth"],
  ["email", "email"],
  ["phone", "phone"],
  ["first_name", "person_name"],
  ["street_address", "street_address"],
  ["ip_address", "ip_address"],
  ["city", "geo"],
];

for (const [name, category] of CASES) {
  test(`classifies ${name} as ${category}`, () => {
    const m = classify(name);
    assert.ok(m, `expected ${name} to be classified`);
    assert.equal(m.category, category);
  });
}

test("non-PII columns classify as null", () => {
  for (const name of ["widget_count", "created_at", "status", "quantity"]) {
    assert.equal(classify(name), null, `${name} should not be PII`);
  }
});

test("high-risk categories carry high sensitivity", () => {
  for (const name of ["ssn", "tax_id", "passport", "national_id"]) {
    assert.equal(classify(name)?.sensitivity, "high");
  }
});

test("geo is low sensitivity", () => {
  assert.equal(classify("city")?.sensitivity, "low");
});
