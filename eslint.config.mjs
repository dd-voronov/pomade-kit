// Flat-config typescript-eslint, type-aware, mirroring Pomade's approach: no preset wholesale,
// hand-picked rules for silent bug classes (floating/misused promises, unused bindings,
// duplicate imports) plus Playwright's missing-await family for the e2e specs.
import tseslint from "typescript-eslint";
import playwright from "eslint-plugin-playwright";

const tsconfigRootDir = import.meta.dirname;

const baseHygieneRules = {
  "no-var": "error",
  "prefer-const": "error",
  "prefer-rest-params": "error",
  "prefer-spread": "error",
  "no-duplicate-imports": ["error", { allowSeparateTypeImports: true }],
};

const typeAwareRules = {
  "@typescript-eslint/no-floating-promises": "error",
  "@typescript-eslint/no-misused-promises": "error",
  "@typescript-eslint/await-thenable": "error",
  "@typescript-eslint/switch-exhaustiveness-check": "error",
  "@typescript-eslint/no-unnecessary-condition": "error",
  "@typescript-eslint/no-unused-vars": [
    "error",
    { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", ignoreRestSiblings: true },
  ],
  "@typescript-eslint/no-explicit-any": "error",
};

const typeAware = {
  languageOptions: { parser: tseslint.parser, parserOptions: { project: ["tsconfig.json"], tsconfigRootDir } },
  plugins: { "@typescript-eslint": tseslint.plugin },
  rules: { ...baseHygieneRules, ...typeAwareRules },
};

export default tseslint.config(
  { ignores: ["private/**", "dist/**", "examples/hello/dist/**", "test-results/**", "playwright-report/**", "**/*.d.ts"] },
  tseslint.configs.base,
  { name: "pomade-kit/config", files: ["eslint.config.mjs"], rules: baseHygieneRules },
  { name: "pomade-kit/src", files: ["src/**/*.ts", "examples/**/*.ts", "vitest.config.ts", "playwright.config.ts"], ...typeAware },
  {
    name: "pomade-kit/e2e",
    files: ["e2e/**/*.ts"],
    ...typeAware,
    plugins: { "@typescript-eslint": tseslint.plugin, playwright },
    rules: { ...baseHygieneRules, ...typeAwareRules, ...playwright.configs["flat/recommended"].rules },
  },
);
