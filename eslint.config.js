// Flat ESLint config — correctness-focused, not style (Prettier owns style).
import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["dist/", "public/", "shots/", "node_modules/"] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // The codebase leans on try/catch-and-ignore for best-effort teardown
      // (network channels, clipboard) — an empty catch is intentional there.
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
];
