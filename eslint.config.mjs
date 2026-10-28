import js from "@eslint/js";
import globals from "globals";

export default [
  {
    // This example is a paste-in object, not a standalone JavaScript program.
    ignores: ["node_modules/**", "coverage/**", "config.example.js"]
  },
  js.configs.recommended,
  { files: ["**/*.js", "**/*.mjs"], languageOptions: { ecmaVersion: 2023 } },
  {
    files: ["MMM-Libre2.js"],
    languageOptions: { sourceType: "script", globals: { ...globals.browser, Module: "readonly" } }
  },
  {
    files: ["node_helper.js", "lib/**/*.js", "test/**/*.js"],
    languageOptions: { sourceType: "commonjs", globals: globals.node }
  },
  {
    files: ["eslint.config.mjs"],
    languageOptions: { sourceType: "module", globals: globals.node }
  }
];
