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
          // Repo-wide backstop against a test suite reaching the real
          // internet. Every outbound `fetch` from worker code under test —
          // `ResendNotifier`'s calls to api.resend.com above all — is answered
          // here instead of leaving the machine. Until now the only thing
          // stopping a live send during a test run was each suite remembering
          // to install its own `fetch` spy; a forgotten one would have hit
          // Resend for real, with a real API key on CI, once `NOTIFIER=resend`
          // exists as a working path.
          //
          // Returns a 599 with a plainly-worded body rather than throwing:
          // `ResendNotifier.sendBatch` catches network errors and turns them
          // into `{ ok: false }` results, so a thrown error would be swallowed
          // into a generic failure, while this status and body surface
          // verbatim in the assertion diff and name the cause.
          outboundService: (request: Request) =>
            new Response(
              `outbound network access is disabled in tests (vitest.config.ts). Blocked: ${request.method} ${request.url}. Install a fetch spy in this suite.`,
              { status: 599 },
            ),
          bindings: {
            TEST_MIGRATIONS: migrations,
            // CI has no `.dev.vars` (gitignored, local-dev-only), so any test
            // that reads RESPONSE_TOKEN_SECRET off the binding gets undefined
            // there unless it's provided here too. This value is committed on
            // purpose — it is obviously fake and used nowhere but tests.
            RESPONSE_TOKEN_SECRET: "test-only-secret-not-used-in-any-real-environment",
            // Pinned so the suite does not inherit whatever `vars.NOTIFIER` in
            // wrangler.jsonc happens to say. It said "console" for the whole of
            // M0-M3, so every test that exercises the sweep was implicitly
            // relying on a production config value; flipping that var to
            // "resend" for the first live send turned 13 tests red at once,
            // all of them on the factory's fail-closed guard rather than on
            // anything they were written to check. Tests that want another
            // notifier construct it themselves.
            NOTIFIER: "console",
            // The cancel-token key is a *different* secret from the response
            // one in every environment (see `CANCEL_TOKEN_SECRET` in
            // src/env.ts for why), so it must differ here too — a test suite
            // that shared one value could not tell the two apart, and the
            // "a cancel token signed with the response secret is rejected"
            // test would pass for the wrong reason.
            CANCEL_TOKEN_SECRET: "test-only-cancel-secret-not-used-in-any-real-environment",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      // Parallel milestone work lives in git worktrees under `.worktrees/`,
      // which sits inside this directory. Vitest's discovery does not consult
      // .gitignore, so without this the primary checkout also collects every
      // sibling branch's tests — a run here reported 1245 tests instead of 416,
      // silently mixing three branches' suites together.
      exclude: ["**/node_modules/**", "**/dist/**", "**/.wrangler/**", ".worktrees/**"],
    },
  };
});
