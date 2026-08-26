// Flat ESLint config — correctness-focused, not style (Prettier owns style).
// The whole project is TypeScript; tsc --noEmit (npm run typecheck) is the
// real type gate — linting stays syntax-level so every run is fast.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "public/", "shots/", "node_modules/"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // The codebase leans on try/catch-and-ignore for best-effort teardown
      // (network channels, clipboard) — an empty catch is intentional there.
      "no-empty": ["error", { allowEmptyCatch: true }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
