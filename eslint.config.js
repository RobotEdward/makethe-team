import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // `.worktrees/**` for the same reason vitest.config.ts excludes it: parallel
  // milestone work lives in git worktrees inside this directory, eslint does not
  // consult .gitignore, and linting here would otherwise report another
  // branch's in-progress violations as if they were this checkout's.
  {
    ignores: [
      "node_modules/**",
      ".wrangler/**",
      "dist/**",
      ".worktrees/**",
      "worker-configuration.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Node scripts, not Worker code. `no-undef` is off for TypeScript files —
  // typescript-eslint disables it, because the compiler already does that job
  // better — so this only bites the plain-JS tooling under `scripts/`, which
  // legitimately runs on Node and uses its globals. Listed explicitly rather
  // than pulling in the `globals` package for two names.
  {
    files: ["scripts/**/*.{js,mjs}"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly" },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-restricted-syntax": [
        "error",
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: "Domain code must take `now` as a parameter. See the plan's Global Constraints.",
        },
      ],
    },
  },
);
