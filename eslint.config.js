import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/", "coverage/", "dist/"] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      // Leading underscore = "intentionally unused" (e.g. required-arity params).
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      eqeqeq: ["error", "always"],
      // Application code logs through pino (structured, redacted), never console.
      "no-console": "error",
    },
  },
  {
    files: ["tests/**/*.js"],
    languageOptions: { globals: { ...globals.jest } },
  },
  {
    // CLI scripts and real-model tests print to the terminal on purpose.
    files: ["tests/llm/**/*.js", "scripts/**/*.js"],
    rules: { "no-console": "off" },
  },
];
