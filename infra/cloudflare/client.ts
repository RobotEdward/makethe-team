import { API_BASE, RATE_LIMIT_PHASE, WAF_CUSTOM_PHASE, ZONE_ID, requireToken } from "./zone.js";
import type { LiveRule } from "./diff.js";

/**
 * The thinnest wrapper over the Cloudflare API that `plan`, `apply` and
 * `verify` need. No SDK and no Terraform provider: the Rulesets phase
 * entrypoint is a full replace, so the whole of "apply" is one PUT and the
 * whole of "read current state" is one GET.
 */

interface ApiResponse<T> {
  success: boolean;
  result: T;
  errors: { code: number; message: string }[];
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${requireToken()}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  const body = (await response.json()) as ApiResponse<T>;
  if (!body.success) {
    const detail = body.errors?.map((e) => `${e.code} ${e.message}`).join("; ") ?? "unknown";
    // 10000 is what Cloudflare returns for a token that is valid but lacks the
    // permission, which is by far the likeliest failure here and reads as a
    // generic auth error unless it is named.
    const hint = body.errors?.some((e) => e.code === 10000)
      ? `\n\nThat usually means the token lacks a permission, not that it is invalid.\nThis needs Zone → Firewall Services → Edit.`
      : "";
    throw new Error(`${init.method ?? "GET"} ${path} failed: ${detail}${hint}`);
  }
  return body.result;
}

interface RulesetEntrypoint {
  id: string;
  rules?: {
    description?: string;
    action: string;
    expression: string;
    enabled: boolean;
  }[];
}

/**
 * The rules currently live in one phase.
 *
 * A zone that has never had a rule in a phase has no ruleset there at all and
 * the API answers 404, which `call` surfaces as a failure. That is a normal
 * starting state, not an error, so it is reported as "no rules" instead.
 */
export async function readPhase(phase: string): Promise<LiveRule[]> {
  try {
    const entrypoint = await call<RulesetEntrypoint>(
      `/zones/${ZONE_ID}/rulesets/phases/${phase}/entrypoint`,
    );
    return (entrypoint.rules ?? []).map((rule) => ({
      description: rule.description ?? "",
      action: rule.action,
      expression: rule.expression,
      enabled: rule.enabled,
    }));
  } catch (error) {
    if (error instanceof Error && /\b10\d{3}\b.*not found|404/i.test(error.message)) {
      return [];
    }
    throw error;
  }
}

export const readWafCustom = () => readPhase(WAF_CUSTOM_PHASE);
export const readRateLimit = () => readPhase(RATE_LIMIT_PHASE);

/**
 * Replace every rule in a phase with `rules`.
 *
 * A full replace, which is what makes this repo declarative without a state
 * file: whatever is in the phase afterwards is exactly what was declared here.
 * Anything added by hand in the dashboard is removed — `plan` shows that as a
 * removal first, which is the point.
 */
export async function writePhase(phase: string, rules: unknown[]): Promise<void> {
  await call(`/zones/${ZONE_ID}/rulesets/phases/${phase}/entrypoint`, {
    method: "PUT",
    body: JSON.stringify({ rules }),
  });
}

/** Whether Bot Fight Mode is on. It must not be — see the README. */
export async function readBotFightMode(): Promise<boolean> {
  const result = await call<{ fight_mode?: boolean }>(`/zones/${ZONE_ID}/bot_management`);
  return result.fight_mode === true;
}
