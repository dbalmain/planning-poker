import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      ".wrangler/**",
      // Wrangler-generated; already carries /* eslint-disable */.
      "worker-configuration.d.ts",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // projectService only discovers files named tsconfig.json. The Workers
        // types live in tsconfig.worker.json; worker/tsconfig.json is a thin
        // pointer so this service can find them. Browser files use the root
        // tsconfig.json; tests use test/tsconfig.json.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/prefer-readonly": "error",
      "@typescript-eslint/prefer-nullish-coalescing": "error",
      "@typescript-eslint/prefer-optional-chain": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/no-confusing-void-expression": [
        "error",
        { ignoreArrowShorthand: true },
      ],
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],
      eqeqeq: ["error", "always", { null: "ignore" }],
      // console.log is banned; info/warn/error are the Worker's structured log
      // channels (cron sweep + logInternalError). totp-tester only allows
      // warn/error — this repo has a legitimate info-level operational line.
      "no-console": ["warn", { allow: ["warn", "error", "info"] }],
      "no-var": "error",
      "object-shorthand": "error",
      "prefer-const": "error",
    },
  },
  {
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
    },
  },
  {
    // Ambient module augmentation must use `interface` and often names types
    // via import(). The generated worker-configuration.d.ts is ignored.
    files: ["**/*.d.ts"],
    rules: {
      "@typescript-eslint/consistent-type-definitions": "off",
      "@typescript-eslint/consistent-type-imports": "off",
    },
  },
  {
    files: [
      "eslint.config.js",
      "vite.config.ts",
      "vitest.config.ts",
      "vitest.unit.config.ts",
    ],
    ...tseslint.configs.disableTypeChecked,
  },
  // Plain JS outside the TypeScript project: theme-init.js ships to the browser
  // (it runs before the bundle, so it must be linted) and scripts/ runs on Node.
  {
    files: ["public/*.js", "scripts/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      // Outside tsconfig's `include`, so parse standalone rather than via the
      // project service; the type-aware rules are off here anyway.
      parserOptions: { projectService: false },
      globals: {
        console: "readonly",
        document: "readonly",
        fetch: "readonly",
        localStorage: "readonly",
        process: "readonly",
        window: "readonly",
      },
    },
  },
  {
    // A CLI report is what this script is for; shipped code still may not log.
    files: ["scripts/*.mjs"],
    rules: { "no-console": "off" },
  },
  // Turn off rules that conflict with Prettier (must be last).
  eslintConfigPrettier,
);
