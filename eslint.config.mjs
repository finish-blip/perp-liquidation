import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      ".pnpm-store/**",
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "bin/**/*.mjs",
      "eslint.config.mjs",
      "vitest.e2e.config.mjs"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        {
          "allowBoolean": true,
          "allowNumber": true
        }
      ]
    }
  }
];
