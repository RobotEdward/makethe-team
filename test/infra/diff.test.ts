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

  it("ignores whitespace differences in an expression", () => {
    // Cloudflare returns multi-predicate expressions pretty-printed across
    // lines. Comparing raw strings reported every such rule as drift, which
    // trains you to run `apply` on a diff you have stopped reading.
    const pretty = '(path contains "/wp-")\n  or  (path eq "/x")';
    const flat = '(path contains "/wp-") or (path eq "/x")';

    expect(diffRules([{ ...desired[0]!, expression: flat }], live([{ ...desired[0]!, expression: pretty }]))).toEqual([]);
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
