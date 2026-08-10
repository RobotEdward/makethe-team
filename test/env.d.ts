import type { Bindings } from "../src/env.js";

// NOTE: deviates from the brief's literal `declare module "cloudflare:test" {
// interface ProvidedEnv extends Bindings { ... } }`. The installed
// @cloudflare/vitest-pool-workers@0.20.3 no longer types `env` (exported
// from "cloudflare:test") as `ProvidedEnv` — that interface does not exist
// anywhere in the package's shipped .d.ts files. Instead `env` is typed as
// `Cloudflare.Env`, the same ambient namespace that `wrangler types` would
// otherwise populate via a generated (gitignored, not part of this repo's
// CI) worker-configuration.d.ts. The fix is the equivalent module
// augmentation for this version: extend `Cloudflare.Env` inside
// `declare global`. This still satisfies the brief's real requirement —
// `env` (and therefore what Task 9 passes into `handleScheduled`) is typed
// as the full `Bindings` interface, not a partial subset — via the same
// top-level `import type` + declaration-merge mechanism, just anchored to
// the namespace this package version actually uses.
declare global {
  namespace Cloudflare {
    interface Env extends Bindings {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
