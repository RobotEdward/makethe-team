import { describe, expect, it } from "vitest";

/**
 * Both test environments load production's `vars`.
 *
 * `vitest.config.ts` passes `wrangler: { configPath: "./wrangler.jsonc" }`,
 * and the browser suite runs `wrangler dev` against the same file. So every
 * var in that block is a production value the tests inherit unless something
 * deliberately overrides it — `miniflare.bindings` for the server suite,
 * `test/browser/browser.env` for the browser one.
 *
 * That has now broken a suite twice, and the second time is why this file
 * exists. Flipping `NOTIFIER` to "resend" for the first live send turned 13
 * server tests red. Turning on `EMAIL_SPILLOVER` for M54 turned 671 red — and
 * the pin that fixed it went into `vitest.config.ts` only, so the browser
 * suite kept inheriting "cloudflare", threw on every send, and left
 * `seedWorld` with no open fixture. Every browser test and `guide:capture`
 * failed in `beforeAll` for ten days, which is exactly how the last capture
 * outage hid four defects.
 *
 * The class, stated: **a production var pinned in one test config and not the
 * other is a decision, and has to be written down as one.** This enumerates
 * every var with what each environment does about it. A new var fails until
 * it is classified; a var that quietly changes side fails too.
 */

type Treatment = "pinned" | "inherited";

interface Classification {
  vitest: Treatment;
  browser: Treatment;
  /** What the treatment buys, or what inheriting it costs. */
  why: string;
}

const VARS: Record<string, Classification> = {
  NOTIFIER: {
    vitest: "pinned",
    browser: "pinned",
    why: "Production says resend, which needs an API key neither suite has. The server suite pins console; the browser suite pins console too, or sign-in fails into an error signin.ts swallows.",
  },
  EMAIL_SPILLOVER: {
    vitest: "pinned",
    browser: "pinned",
    why: "Production says cloudflare, which throws with no CLOUDFLARE_EMAIL_API_TOKEN. This is the var that broke both suites; see this file's header.",
  },
  EMAIL_WARMUP_PER_DAY: {
    vitest: "pinned",
    browser: "pinned",
    why: "Routes the first n sends of a UTC day down the spill leg, so it is only inert while EMAIL_SPILLOVER is. Pinned to 0 beside it so neither depends on the other's pin surviving.",
  },
  PUSH_NOTIFIER: {
    vitest: "pinned",
    browser: "pinned",
    why: "Production says webpush, whose constructor calls requireBinding on VAPID_PRIVATE_KEY — a secret, so absent in both. Left inherited, every route that builds a notifier 500s.",
  },
  VAPID_PUBLIC_KEY: {
    vitest: "pinned",
    browser: "inherited",
    why: "The server suite pins a known fake so key-shape assertions have something fixed to read. The browser suite wants production's value inherited and its private half missing: that is the real pre-turn-on state test/browser/push.spec.ts asserts against.",
  },
  VAPID_SUBJECT: {
    vitest: "pinned",
    browser: "inherited",
    why: "Pinned with the key above for the same reason, and inherited in the browser suite for the same reason. Harmless either way — nothing in the browser suite reads it.",
  },
  MAX_EMAILS_PER_DAY: {
    vitest: "inherited",
    browser: "pinned",
    why: "Production's 95 is a cost control (TR-31). The browser suite raises it because one clean pass sends about 50 and would otherwise run its tail with delivery refused. The server suite sets the ceiling per test where it matters, so inheriting is fine.",
  },
  BETTER_AUTH_URL: {
    vitest: "inherited",
    browser: "pinned",
    why: "The browser suite must pin localhost or magic links are minted against production's origin and every POST fails the same-origin check with a bare 403. The server suite passes an origin per request.",
  },
  MAX_EMAILS_PER_DAY_CLOUDFLARE: {
    vitest: "inherited",
    browser: "inherited",
    why: "A ceiling on a leg both suites have switched off via EMAIL_SPILLOVER, so its value cannot be reached. Tests that exercise the leg build it themselves.",
  },
  CLOUDFLARE_ACCOUNT_ID: {
    vitest: "inherited",
    browser: "inherited",
    why: "Only read when building the Cloudflare send URL, on the leg both suites have switched off. Not a secret, and wrong here would be visible in an assertion rather than silent.",
  },
  EMAIL_FROM: {
    vitest: "inherited",
    browser: "inherited",
    why: "A display value on a message neither suite delivers. Several tests assert the production address verbatim, which inheriting is what makes true.",
  },
};

const RAW = import.meta.glob("../../{wrangler.jsonc,vitest.config.ts}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const BROWSER_ENV = import.meta.glob("../browser/browser.env", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function read(suffix: string, from: Record<string, string>): string {
  const found = Object.entries(from).find(([path]) => path.endsWith(suffix));
  expect(found, `this guard could not read ${suffix}; fix the glob before trusting it`).toBeDefined();
  return found![1];
}

/** Every key in wrangler.jsonc's top-level `vars` block. */
function productionVars(): string[] {
  // Whole-line comments dropped rather than every `//`, because the values
  // include URLs and stripping those would truncate the block.
  const source = read("wrangler.jsonc", RAW)
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  const start = source.indexOf(`"vars"`);
  const open = source.indexOf("{", start);
  let depth = 0;
  let close = open;
  for (; close < source.length; close += 1) {
    if (source[close] === "{") depth += 1;
    else if (source[close] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }

  return [...source.slice(open + 1, close).matchAll(/^\s*"([A-Z0-9_]+)"\s*:/gm)].map((m) => m[1]!);
}

const pinnedInVitest = (name: string): boolean =>
  new RegExp(`^\\s*${name}:`, "m").test(read("vitest.config.ts", RAW));

const pinnedInBrowserEnv = (name: string): boolean =>
  new RegExp(`^${name}=`, "m").test(read("browser.env", BROWSER_ENV));

describe("production vars the test environments inherit", () => {
  it("reads the three files it compares", () => {
    // Guards the scan. A glob that silently matched nothing would make every
    // assertion below pass while comparing empty strings.
    expect(read("wrangler.jsonc", RAW)).toContain(`"vars"`);
    expect(read("vitest.config.ts", RAW)).toContain("bindings:");
    expect(read("browser.env", BROWSER_ENV)).toContain("NOTIFIER=");
    expect(productionVars().length).toBeGreaterThan(5);
  });

  it("classifies every var wrangler.jsonc declares", () => {
    expect(productionVars().sort()).toEqual(Object.keys(VARS).sort());
  });

  it.each(Object.entries(VARS))("%s — $why", (name, expected) => {
    expect(
      pinnedInVitest(name) ? "pinned" : "inherited",
      `vitest.config.ts's treatment of ${name} no longer matches what this ` +
        `file records. If the change is deliberate, update the entry and its ` +
        `reason; if it is not, it is a production value leaking into the ` +
        `server suite.`,
    ).toBe(expected.vitest);

    expect(
      pinnedInBrowserEnv(name) ? "pinned" : "inherited",
      `test/browser/browser.env's treatment of ${name} no longer matches what ` +
        `this file records. A var pinned for the server suite and forgotten ` +
        `here is the exact failure that broke every browser test for ten days.`,
    ).toBe(expected.browser);
  });
});
