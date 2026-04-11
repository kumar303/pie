import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import vitest from "@vitest/eslint-plugin";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["extensions/**/*.ts"],
    rules: {
      // Allow unused vars prefixed with _
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Allow explicit `any` — strict mode is off in tsconfig
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["extensions/**/*.test.ts"],
    plugins: { vitest },
    rules: {
      "vitest/no-conditional-in-test": "error",
    },
  },
  {
    ignores: ["**/*.js", "node_modules"],
  },
);
