/**
 * What `plan` prints and what `apply` would change.
 *
 * The Rulesets API's phase entrypoint is a **full replace** — `apply` PUTs the
 * whole rule list for a phase — so there is no state file and no reconciliation
 * to get wrong: the zone is the state. This diff exists purely so a human can
 * read what a replace would do before doing it.
 */

/** A rule as declared in this repo, rendered ready to send. */
export interface DesiredRule {
  description: string;
  action: string;
  expression: string;
}

/** A rule as Cloudflare currently holds it. */
export interface LiveRule extends DesiredRule {
  enabled: boolean;
}

export type Change =
  | { kind: "add"; description: string }
  | { kind: "remove"; description: string }
  | { kind: "change"; description: string; field: string; from: string; to: string };

/**
 * Compares by `description`, which Cloudflare shows as the rule name and this
 * repo treats as a rule's stable identity. Renaming a rule therefore reads as
 * a remove plus an add, which is honest: to Cloudflare that is what it is.
 */
export function diffRules(desired: DesiredRule[], liveRules: LiveRule[]): Change[] {
  const changes: Change[] = [];
  const byDescription = new Map(liveRules.map((rule) => [rule.description, rule]));

  for (const want of desired) {
    const have = byDescription.get(want.description);
    if (have === undefined) {
      changes.push({ kind: "add", description: want.description });
      continue;
    }
    if (have.expression !== want.expression) {
      changes.push({
        kind: "change",
        description: want.description,
        field: "expression",
        from: have.expression,
        to: want.expression,
      });
    }
    if (have.action !== want.action) {
      changes.push({
        kind: "change",
        description: want.description,
        field: "action",
        from: have.action,
        to: want.action,
      });
    }
    // A rule switched off in the dashboard is drift as surely as an edited
    // expression, and is the easier of the two to do by accident. Everything
    // this repo declares is meant to be live.
    if (!have.enabled) {
      changes.push({
        kind: "change",
        description: want.description,
        field: "enabled",
        from: "false",
        to: "true",
      });
    }
  }

  const wanted = new Set(desired.map((rule) => rule.description));
  for (const have of liveRules) {
    if (!wanted.has(have.description)) {
      changes.push({ kind: "remove", description: have.description });
    }
  }

  return changes;
}

/** One line per change, for `plan`'s output. */
export function formatChange(change: Change): string {
  switch (change.kind) {
    case "add":
      return `  + ${change.description}`;
    case "remove":
      return `  - ${change.description}  (exists on the zone, not declared here)`;
    case "change":
      return `  ~ ${change.description}  ${change.field}\n      live:    ${change.from}\n      desired: ${change.to}`;
  }
}
