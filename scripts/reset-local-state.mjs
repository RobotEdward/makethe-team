// Wipe the local `wrangler dev` state and rebuild an empty D1 from the
// migrations.
//
// `playwright.config.ts` runs this immediately before it starts the browser
// suite's `wrangler dev`, because that suite's cost grows with everything
// every previous run left behind.
//
// The mechanism, measured 15 August 2026: `seedWorld` creates a game per test
// and then triggers the daily materialisation cron, and that cron expands the
// recurrence of *every game in the database*, not just the one the test made.
// After a fortnight of local runs the D1 held 349 games and 1,899 fixtures, so
// each of the suite's ~20 seeds swept all 349 — work that scales with run
// history and has nothing to do with the test doing the sweeping. Suite time
// had drifted from 3.3 to 5.0 minutes.
//
// It also caused a genuine failure, not just slowness. `MAX_EMAILS_PER_DAY`
// (TR-31) is counted per UTC day in the `email_quota` table, which no test
// clears; sweeping hundreds of stale games burned that ceiling, and the leave
// journey failed once during the M7a merge because the ceiling — not the code
// — refused its email. That is the worst kind of flake: a red test with a
// green cause.
//
// CI never sees any of this. It checks out fresh, so `.wrangler` is empty on
// every run — which is exactly why the degradation went unnoticed locally for
// as long as it did.
//
// Four directories go, each for its own reason:
//
//   d1            — the accumulation above.
//   do            — `FixtureCapacity` objects keyed by fixture id. Wiping D1
//                   without these would leave capacity state for fixtures that
//                   no longer exist; harmless but unbounded.
//   observability — `wrangler dev`'s local log store, and by far the largest
//                   thing here: 1.3 GB against D1's 3 MB. Pure disk, no effect
//                   on suite time, but nothing else ever prunes it.
//   tmp           — build scratch, 416 MB of it, same story.
//
// Deliberately *not* deleted: `.wrangler/state/v3/cache` and `workflows`, which
// are small and hold nothing this suite writes.
//
// Consequence worth knowing: `npm run dev` shares this D1, so running the
// browser suite discards anything you set up by hand. That was already
// effectively true — the suite wrote hundreds of games into the same database —
// but it is now immediate and total rather than gradual.

import { rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const DOOMED = [
  ".wrangler/state/v3/d1",
  ".wrangler/state/v3/do",
  ".wrangler/state/v3/observability",
  ".wrangler/tmp",
];

for (const path of DOOMED) {
  await rm(path, { recursive: true, force: true });
}

// Recreates the D1 file and applies all migrations in one process. `--local`
// never touches the remote database; the binding name and `migrations_dir`
// both come from `wrangler.jsonc`.
const { stdout } = await run(
  "npx",
  ["wrangler", "d1", "migrations", "apply", "makethe-team", "--local"],
  { cwd: process.cwd(), maxBuffer: 4 * 1024 * 1024 },
);

// Wrangler prints each migration's name twice — once as "to be applied" and
// again in the results table — so the names are not the thing to count. This
// line is, and it is the one wrangler states the intent on.
const applied = Number(stdout.match(/About to apply (\d+) migration/)?.[1] ?? 0);

// Fail here rather than let the suite discover it. An empty D1 with no schema
// produces twenty timing-out tests whose first visible symptom is `seedWorld`
// failing to find a fixture — a long way from "the migrations did not run".
if (applied === 0) {
  throw new Error(
    `reset-local-state: applied no migrations, so the D1 has no schema. wrangler said:\n${stdout}`,
  );
}

// One line, so a suite run does not open with a wall of wrangler output.
console.log(`reset-local-state: wiped local wrangler state, applied ${applied} migration(s)`);
