import { RATE_LIMIT_RULES } from "./rules/rate-limit.js";
import { WAF_CUSTOM_RULES, renderExpression } from "./rules/waf-custom.js";
import type { DesiredRule } from "./diff.js";

/**
 * The declarations, rendered ready to compare against what is live.
 *
 * Its own module so that `apply` can import them **without importing
 * `plan`** — `plan.ts` runs its `main()` at the top level, so importing it
 * executed the entire plan as a side effect and `apply` printed the diff
 * twice. A module that does work when imported is a module that cannot be
 * reused.
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
