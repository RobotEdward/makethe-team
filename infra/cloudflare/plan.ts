import { diffRules, formatChange, type DesiredRule } from "./diff.js";
import { readBotFightMode, readRateLimit, readWafCustom } from "./client.js";
import { RATE_LIMIT_RULES } from "./rules/rate-limit.js";
import { WAF_CUSTOM_RULES, renderExpression } from "./rules/waf-custom.js";
import { ZONE_NAME } from "./zone.js";

/**
 * Print what `apply` would change, and change nothing.
 *
 * Run this before every apply. The Rulesets phase entrypoint is a full
 * replace, so an apply removes anything on the zone that is not declared
 * here — this is where you find that out.
 */

export function desiredWafRules(): DesiredRule[] {
  return WAF_CUSTOM_RULES.map((rule) => ({
    description: rule.description,
    action: rule.action,
    expression: renderExpression(rule),
  }));
}

export function desiredRateLimitRules(): DesiredRule[] {
  return RATE_LIMIT_RULES.map((rule) => ({
    description: rule.description,
    action: rule.action,
    expression: rule.expression,
  }));
}

async function section(title: string, desired: DesiredRule[], read: () => Promise<import("./diff.js").LiveRule[]>): Promise<number> {
  const changes = diffRules(desired, await read());
  console.log(`\n${title}`);
  if (changes.length === 0) {
    console.log("  no changes");
  } else {
    for (const change of changes) console.log(formatChange(change));
  }
  return changes.length;
}

async function main(): Promise<void> {
  console.log(`Cloudflare edge configuration for ${ZONE_NAME}`);

  let total = 0;
  total += await section("WAF custom rules", desiredWafRules(), readWafCustom);
  total += await section("Rate limiting rules", desiredRateLimitRules(), readRateLimit);

  console.log("\nBot Fight Mode");
  const botFightMode = await readBotFightMode();
  if (botFightMode) {
    total += 1;
    console.log("  ! ON — it must be OFF. It challenges datacentre IPs, which breaks");
    console.log("    the GitHub Actions smoke check. Turn it off in the dashboard:");
    console.log("    Security → Bots → Bot Fight Mode. See the README.");
  } else {
    console.log("  off, as required");
  }

  console.log(
    total === 0
      ? "\nThe zone matches this repo."
      : `\n${total} difference(s). Run \`npm run cf:apply\` to make the zone match.`,
  );
}

// A missing or under-permissioned token is the expected failure here, not a
// bug, so it gets a message rather than a stack trace.
try {
  await main();
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
