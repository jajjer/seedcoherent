import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "demo", ".claude", ".context"] },
  eslint.configs.recommended,
  // Non-type-checked recommended rules: fast, low-noise on an existing
  // codebase. `tsc --strict` already covers type correctness.
  ...tseslint.configs.recommended,
  {
    // Everything here runs on Node (CLI, library, tests, build scripts).
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // Deliberate in the pgsql-ast-parser AST traversal (schema-file.ts),
      // dynamic config loading, and test fixtures. Surfaced as a warning so
      // it does not block the CI gate but stays visible for later tightening.
      "@typescript-eslint/no-explicit-any": "warn",
      // Allow an underscore prefix to mark an intentionally unused argument
      // (e.g. a parameter kept for a shared signature).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
  // Must come last: switches off formatting rules that would fight Prettier.
  eslintConfigPrettier,
);
