import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

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
      // ANSI escape sequence handling uses control chars in regexes intentionally
      "no-control-regex": "off",
      // Allow require() for .js service files loaded at runtime
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    ignores: ["**/*.js", "node_modules"],
  },
);
