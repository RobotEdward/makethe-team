/**
 * The zone's WAF custom rules (TR-37), as data.
 *
 * Declared as structured predicates rather than as Cloudflare expression
 * strings so that **one declaration drives two consumers**: `renderExpression`
 * builds what `apply.ts` sends to the Rulesets API, and `matchesRule` is what
 * `test/infra/waf-collisions.test.ts` evaluates against real generated tokens.
 * A rule whose live expression and whose collision guard could drift apart
 * would make the guard a decoration — the point is that they cannot.
 *
 * **This is not a security control.** A blocklist is always behind the
 * attackers. It exists to keep scanner noise out of the logs and out of the
 * Worker's request count, and the application is written to be safe with the
 * WAF switched off entirely.
 *
 * The Free plan allows five custom rules. Two are used; the remaining three
 * are deliberately left free.
 */

export type Predicate =
  | { field: "path"; op: "contains"; value: string }
  | { field: "path"; op: "eq"; value: string }
  | { field: "method"; op: "not_in"; values: string[] };

export interface CustomRule {
  /** Cloudflare shows this as the rule name. Also this repo's stable id for it. */
  description: string;
  action: "block";
  /** OR-ed together. A request matching any predicate matches the rule. */
  any: Predicate[];
}

export const WAF_CUSTOM_RULES: CustomRule[] = [
  {
    description: "block-scanner-paths",
    action: "block",
    any: [
      // Every pattern here begins with a literal `/`. That is load-bearing:
      // it is what stops the rule matching a path *segment* that merely
      // happens to contain one of these strings. See
      // `test/infra/waf-collisions.test.ts`, which proves it against real
      // tokens rather than asserting it in prose.
      { field: "path", op: "contains", value: "/wp-" },
      { field: "path", op: "contains", value: "/wordpress" },
      { field: "path", op: "contains", value: "/.env" },
      { field: "path", op: "contains", value: "/.git" },
      { field: "path", op: "contains", value: "/phpmyadmin" },
      { field: "path", op: "contains", value: "/vendor/" },
      { field: "path", op: "contains", value: "/.aws" },
      // `eq`, not `contains`, so it only matches at the root. A game or
      // fixture page ending in this name is not a scanner.
      { field: "path", op: "eq", value: "/config.json" },
    ],
  },
  {
    description: "block-non-standard-methods",
    action: "block",
    // The app registers only GET and POST handlers; HEAD is allowed because
    // Cloudflare and link previewers issue it and Hono answers it from the GET
    // route. Anything else cannot reach a real handler anyway, so blocking it
    // at the edge costs nothing and saves an invocation.
    any: [{ field: "method", op: "not_in", values: ["GET", "HEAD", "POST"] }],
  },
];

/**
 * There is deliberately no bot-scoring rule. The `cf.bot_management.*` fields
 * need a paid Bot Management subscription, which this zone (Free Website) does
 * not have, so such a rule fails validation on apply. Do not re-add one.
 */

/**
 * Build the Cloudflare expression string this rule is applied as.
 *
 * A lone predicate is rendered **without** wrapping parentheses. Cloudflare
 * stores an expression as it is given, and a rule created in the dashboard has
 * none — so adding them would make such a rule report as drift on every `plan`,
 * forever, for no semantic difference. A diff that always shows changes is one
 * you stop reading.
 */
export function renderExpression(rule: CustomRule): string {
  const rendered = rule.any.map(renderPredicate);
  return rendered.length === 1
    ? rendered[0]!
    : rendered.map((predicate) => `(${predicate})`).join(" or ");
}

function renderPredicate(predicate: Predicate): string {
  switch (predicate.field) {
    case "path":
      return `http.request.uri.path ${predicate.op} "${predicate.value}"`;
    case "method":
      return `not http.request.method in {${predicate.values.map((m) => `"${m}"`).join(" ")}}`;
  }
}

/** Whether a request would be blocked by this rule. The matcher `renderExpression` promises. */
export function matchesRule(rule: CustomRule, request: { path: string; method: string }): boolean {
  return rule.any.some((predicate) => matchesPredicate(predicate, request));
}

function matchesPredicate(
  predicate: Predicate,
  request: { path: string; method: string },
): boolean {
  switch (predicate.field) {
    case "path":
      return predicate.op === "contains"
        ? request.path.includes(predicate.value)
        : request.path === predicate.value;
    case "method":
      return !predicate.values.includes(request.method);
  }
}
