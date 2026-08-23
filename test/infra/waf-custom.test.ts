import { describe, expect, it } from "vitest";
import {
  WAF_CUSTOM_RULES,
  matchesRule,
  renderExpression,
} from "../../infra/cloudflare/rules/waf-custom.js";

/**
 * The rules are declared as structured predicates, not as expression strings,
 * so that one declaration drives both what is sent to Cloudflare
 * (`renderExpression`) and what the collision guard evaluates (`matchesRule`).
 * A rule that is tightened in the dashboard-facing string but not in the
 * matcher — or the reverse — is the failure this shape exists to prevent.
 */
describe("renderExpression", () => {
  it("renders a path-contains rule as Cloudflare's expression language", () => {
    const expression = renderExpression({
      description: "example",
      action: "block",
      any: [{ field: "path", op: "contains", value: "/wp-" }],
    });

    // No wrapping parentheses around a lone predicate: Cloudflare stores the
    // expression as given, and a rule created in the dashboard has none. Adding
    // them would make every such rule report as drift on every `plan` forever.
    expect(expression).toBe('http.request.uri.path contains "/wp-"');
  });

  it("ORs multiple predicates", () => {
    const expression = renderExpression({
      description: "example",
      action: "block",
      any: [
        { field: "path", op: "contains", value: "/wp-" },
        { field: "path", op: "eq", value: "/config.json" },
      ],
    });

    expect(expression).toBe(
      '(http.request.uri.path contains "/wp-") or (http.request.uri.path eq "/config.json")',
    );
  });

  it("renders the method rule as a negated set membership", () => {
    const expression = renderExpression({
      description: "example",
      action: "block",
      any: [{ field: "method", op: "not_in", values: ["GET", "HEAD", "POST"] }],
    });

    expect(expression).toBe('not http.request.method in {"GET" "HEAD" "POST"}');
  });
});

describe("matchesRule", () => {
  const scanners = WAF_CUSTOM_RULES.find((r) => r.description === "block-scanner-paths");
  const methods = WAF_CUSTOM_RULES.find((r) => r.description === "block-non-standard-methods");

  it("matches the scanner paths the rule exists to block", () => {
    for (const path of ["/wp-admin", "/.env", "/.git/config", "/vendor/autoload.php"]) {
      expect(matchesRule(scanners!, { path, method: "GET" }), path).toBe(true);
    }
  });

  it("matches /config.json only at the root, because the rule uses eq", () => {
    expect(matchesRule(scanners!, { path: "/config.json", method: "GET" })).toBe(true);
    expect(matchesRule(scanners!, { path: "/g/x/config.json", method: "GET" })).toBe(false);
  });

  it("matches any method outside GET, HEAD and POST", () => {
    expect(matchesRule(methods!, { path: "/", method: "PUT" })).toBe(true);
    expect(matchesRule(methods!, { path: "/", method: "DELETE" })).toBe(true);
    for (const method of ["GET", "HEAD", "POST"]) {
      expect(matchesRule(methods!, { path: "/", method }), method).toBe(false);
    }
  });
});
