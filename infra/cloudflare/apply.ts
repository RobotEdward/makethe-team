import { desiredRateLimitRules, desiredWafRules } from "./plan.js";
import { readRateLimit, readWafCustom, writePhase } from "./client.js";
import { diffRules, formatChange } from "./diff.js";
import { RATE_LIMIT_RULES } from "./rules/rate-limit.js";
import { RATE_LIMIT_PHASE, WAF_CUSTOM_PHASE, ZONE_NAME } from "./zone.js";
import { WAF_CUSTOM_RULES, renderExpression } from "./rules/waf-custom.js";

/**
 * Make the zone match this repo.
 *
 * Prints the diff first and refuses to do anything if there is none, so a
 * run that says "no changes" is proof rather than a no-op you have to trust.
 */
async function main(): Promise<void> {
  const wafChanges = diffRules(desiredWafRules(), await readWafCustom());
  const rlChanges = diffRules(desiredRateLimitRules(), await readRateLimit());

  if (wafChanges.length === 0 && rlChanges.length === 0) {
    console.log(`${ZONE_NAME} already matches this repo. Nothing to do.`);
    return;
  }

  for (const change of [...wafChanges, ...rlChanges]) console.log(formatChange(change));

  await writePhase(
    WAF_CUSTOM_PHASE,
    WAF_CUSTOM_RULES.map((rule) => ({
      description: rule.description,
      action: rule.action,
      expression: renderExpression(rule),
      enabled: true,
    })),
  );
  console.log(`\napplied ${WAF_CUSTOM_RULES.length} WAF custom rule(s)`);

  await writePhase(
    RATE_LIMIT_PHASE,
    RATE_LIMIT_RULES.map((rule) => ({
      description: rule.description,
      action: rule.action,
      expression: rule.expression,
      ratelimit: rule.ratelimit,
      enabled: true,
    })),
  );
  console.log(`applied ${RATE_LIMIT_RULES.length} rate limiting rule(s)`);

  console.log("\nNow run `npm run cf:verify` against the live site.");
}

// A missing or under-permissioned token is the expected failure here, not a
// bug, so it gets a message rather than a stack trace.
try {
  await main();
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
