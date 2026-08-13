import type { Page } from "@playwright/test";

export interface Observation {
  errors(): string[];
  violations(): Promise<string[]>;
}

/**
 * Watch a page for the three things a server test can never see: a console
 * error, an uncaught exception, and a Content-Security-Policy violation.
 *
 * The CSP listener is installed via `addInitScript`, which runs before any of
 * the document's own scripts. A listener attached after load would miss
 * violations raised by the page's own inline blocks — which is precisely the
 * case that matters here, since every script and style this app serves is
 * inline and hash-covered.
 *
 * Call this before `page.goto`.
 */
export function observe(page: Page): Observation {
  const errors: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console.error: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${String(error)}`));

  // These callbacks run in the browser, but this project is typed against
  // the Workers runtime and has no DOM lib — so the browser globals are
  // reached through a narrow local shape rather than `window`, which does
  // not exist as a type here.
  const installed = page.addInitScript(() => {
    const store: string[] = [];
    const browser = globalThis as unknown as {
      __csp: string[];
      addEventListener: (
        type: string,
        listener: (event: { violatedDirective: string; blockedURI: string }) => void,
      ) => void;
    };
    browser.__csp = store;
    browser.addEventListener("securitypolicyviolation", (event) => {
      store.push(`${event.violatedDirective} blocked ${event.blockedURI || "(inline)"}`);
    });
  });

  return {
    errors: () => [...errors],
    violations: async () => {
      await installed;
      return page.evaluate(() => (globalThis as unknown as { __csp?: string[] }).__csp ?? []);
    },
  };
}
