// NOTE: deviates from the brief's exact content. The brief specifies
// `defineWorkersConfig`/`readD1Migrations` imported from
// "@cloudflare/vitest-pool-workers/config", which was the v3 API. The
// version resolved by peer-dependency install against vitest ^4.1.0
// (@cloudflare/vitest-pool-workers@0.20.3) removed that "./config" subpath
// entirely as part of its vitest v3 -> v4 migration (see the package's own
// dist/codemods/vitest-v3-to-v4.mjs). The equivalent v4 API is
// `cloudflareTest` (a Vite plugin) + `defineConfig` from "vitest/config",
// with `readD1Migrations` now exported from the package root. The
// `singleWorker` pool option was also removed in this version (no longer
// part of `WorkersPoolOptions`), so it is omitted here. See
// task-1-report.md for details.
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
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
