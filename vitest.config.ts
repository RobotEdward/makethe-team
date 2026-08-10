// This file does NOT use `defineWorkersConfig` / `readD1Migrations` imported
// from "@cloudflare/vitest-pool-workers/config", which is what most
// documentation and examples still show. That was the v3 API. The version
// resolved by peer-dependency install against vitest ^4.1.0
// (@cloudflare/vitest-pool-workers@0.20.3) removed the "./config" subpath
// entirely as part of its vitest v3 -> v4 migration — see the package's own
// dist/codemods/vitest-v3-to-v4.mjs. The v4 equivalent, used below, is the
// `cloudflareTest` Vite plugin plus `defineConfig` from "vitest/config", with
// `readD1Migrations` now exported from the package root. The `singleWorker`
// pool option was dropped from `WorkersPoolOptions` in the same release, so it
// is deliberately absent. Restoring the older shape will not typecheck.
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrationsDir = path.resolve("migrations");
  const migrations = existsSync(migrationsDir) ? await readD1Migrations(migrationsDir) : [];

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // CI has no `.dev.vars` (gitignored, local-dev-only), so any test
            // that reads RESPONSE_TOKEN_SECRET off the binding gets undefined
            // there unless it's provided here too. This value is committed on
            // purpose — it is obviously fake and used nowhere but tests.
            RESPONSE_TOKEN_SECRET: "test-only-secret-not-used-in-any-real-environment",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
