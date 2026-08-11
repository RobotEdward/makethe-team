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
