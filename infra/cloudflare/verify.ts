import { WAF_CUSTOM_RULES, matchesRule } from "./rules/waf-custom.js";
import { ZONE_NAME } from "./zone.js";

/**
 * Check the live site behaves the way the declarations say it should.
 *
 * Needs no token: it makes ordinary public requests. This is the runbook's
 * hand-run `curl` loop, with the expectations derived from the rule data
 * rather than restated — a pattern added to `waf-custom.ts` is checked here
 * automatically, and cannot be forgotten.
 *
 * `403` means the edge blocked the request and it never became a Worker
 * invocation, which is the whole point of these rules. `404` means it reached
 * the Worker, so the rule is not applied. Both are *safe* — the application
 * does not depend on the WAF — but only `403` saves the invocation.
 */

const ORIGIN = `https://${ZONE_NAME}`;

/** One probe per pattern the rules declare, derived from the declarations. */
function blockedProbes(): string[] {
  const paths: string[] = [];
  for (const rule of WAF_CUSTOM_RULES) {
    for (const predicate of rule.any) {
      if (predicate.field !== "path") continue;
      // `contains` patterns all begin with `/`; make a plausible scanner URL
      // from each. `eq` patterns are already a whole path.
      paths.push(predicate.op === "eq" ? predicate.value : `${predicate.value}probe`);
    }
  }
  return paths;
}

/** Paths that must keep working, with the status the app answers them with. */
const MUST_SERVE: { path: string; expect: number }[] = [
  { path: "/", expect: 200 },
  { path: "/robots.txt", expect: 200 },
  { path: "/privacy", expect: 200 },
];

async function status(path: string, method = "GET"): Promise<number> {
  const response = await fetch(`${ORIGIN}${path}`, { method, redirect: "manual" });
  return response.status;
}

async function main(): Promise<void> {
  let failures = 0;
  const check = (ok: boolean, line: string) => {
    console.log(`${ok ? "  ok  " : "  FAIL"} ${line}`);
    if (!ok) failures += 1;
  };

  console.log(`Verifying ${ORIGIN}\n\nBlocked at the edge (expect 403):`);
  for (const path of blockedProbes()) {
    const code = await status(path);
    check(code === 403, `${path.padEnd(24)} ${code}${code === 404 ? "  (reached the Worker — rule not applied)" : ""}`);
  }

  console.log("\nNon-standard methods (expect 403):");
  for (const method of ["PUT", "DELETE", "PATCH"]) {
    const code = await status("/", method);
    check(code === 403, `${method.padEnd(24)} ${code}`);
  }

  console.log("\nMust keep working:");
  for (const { path, expect } of MUST_SERVE) {
    const code = await status(path);
    check(code === expect, `${path.padEnd(24)} ${code} (expected ${expect})`);
  }

  // The guard that matters most, and the one a blocklist makes easy to break:
  // a rule must never match a real player's link. `test/infra/waf-collisions.test.ts`
  // proves this against freshly minted tokens on every `npm test`; this is the
  // same assertion against what is actually live.
  console.log("\nToken links must not match any rule:");
  for (const path of ["/r/eyJhbGciOi", "/j/3dd1de85-a391-44ec-98a2-9e04fd543919", "/leave/eyJx"]) {
    const rule = WAF_CUSTOM_RULES.find((r) => matchesRule(r, { path, method: "GET" }));
    check(rule === undefined, `${path.padEnd(44)} ${rule ? `MATCHES ${rule.description}` : "no rule matches"}`);
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  if (failures > 0) process.exitCode = 1;
}

await main();
