import { describe, expect, it } from "vitest";
import { diffRules, type LiveRule } from "../../infra/cloudflare/diff.js";

const desired = [
  { description: "block-scanner-paths", action: "block", expression: '(path contains "/wp-")' },
  { description: "block-non-standard-methods", action: "block", expression: "(not method)" },
];

function live(rules: Partial<LiveRule>[]): LiveRule[] {
  return rules.map((r) => ({
    description: r.description ?? "",
    action: r.action ?? "block",
    expression: r.expression ?? "",
    enabled: r.enabled ?? true,
  }));
}

describe("diffRules", () => {
  it("reports no changes when live matches desired", () => {
    expect(diffRules(desired, live(desired))).toEqual([]);
  });

  it("reports a rule that does not exist live as an addition", () => {
    const changes = diffRules(desired, live([desired[0]!]));

    expect(changes).toEqual([{ kind: "add", description: "block-non-standard-methods" }]);
  });

  it("reports a live rule that is not desired as a removal", () => {
    const changes = diffRules(desired, live([...desired, { description: "stale-rule" }]));

    expect(changes).toEqual([{ kind: "remove", description: "stale-rule" }]);
  });

  it("reports a changed expression, showing both sides", () => {
    const changes = diffRules(
      desired,
      live([{ ...desired[0]!, expression: '(path contains "/old")' }, desired[1]!]),
    );

    expect(changes).toEqual([
      {
        kind: "change",
        description: "block-scanner-paths",
        field: "expression",
        from: '(path contains "/old")',
        to: '(path contains "/wp-")',
      },
    ]);
  });

  it("reports a rule disabled in the dashboard as a change", () => {
    // Someone toggling a rule off in the UI is drift exactly as much as
    // editing its expression is, and it is the easier of the two to do by
    // accident. Without this, `plan` would report a silently inert rule as
    // matching the declaration.
    const changes = diffRules(desired, live([{ ...desired[0]!, enabled: false }, desired[1]!]));

    expect(changes).toEqual([
      {
        kind: "change",
        description: "block-scanner-paths",
        field: "enabled",
        from: "false",
        to: "true",
      },
    ]);
  });
});
