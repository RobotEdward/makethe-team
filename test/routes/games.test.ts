import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { games } from "../../src/db/schema.js";
import { SCRIPT_BLOCKS } from "../../src/views/scripts.js";
import { interferingBinding } from "../support/interference.js";
import { resetDatabase, testDb } from "../support/factories.js";
import { bindings, ORIGIN, signIn } from "../support/sign-in.js";

async function post(path: string, cookie: string, fields: Record<string, string>) {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

const VALID = {
  name: "Thursday 7-a-side",
  venueName: "Oxford Sports Park",
  weekday: "TH",
  interval: "1",
  kickoffTime: "19:00",
  durationMinutes: "60",
  minPlayers: "10",
  maxPlayers: "14",
  prefersEvenNumbers: "on",
};

describe("GET /g/new", () => {
  beforeEach(resetDatabase);

  it("redirects an anonymous visitor to sign in", async () => {
    const response = await SELF.fetch(`${ORIGIN}/g/new`, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/sign-in");
  });

  it("renders the form for a signed-in player", async () => {
    const { cookie } = await signIn();
    const response = await SELF.fetch(`${ORIGIN}/g/new`, { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Set up a game");
  });
});

describe("POST /g/new", () => {
  beforeEach(resetDatabase);

  it("creates the game and redirects to it", async () => {
    const { cookie } = await signIn();
    const response = await post("/g/new", cookie, VALID);

    expect(response.status).toBe(303);
    const location = response.headers.get("location")!;
    expect(location).toMatch(/^\/g\/[0-9a-f-]{36}$/);

    const [game] = await testDb().select().from(games);
    expect(game?.name).toBe("Thursday 7-a-side");
    expect(location).toBe(`/g/${game!.id}`);
  });

  it("redisplays the form with the submitted values on a bad submission", async () => {
    const { cookie } = await signIn();
    const response = await post("/g/new", cookie, { ...VALID, minPlayers: "20", name: "Keep me" });

    expect(response.status).toBe(422);
    const html = await response.text();
    // Nothing typed is thrown away.
    expect(html).toContain('value="Keep me"');
    // `escapeHtml` escapes `'` to `&#39;` (see its own doc comment) —
    // deliberate, so the assertion matches the escaped form rather than the
    // raw message text.
    expect(html).toContain("The minimum can&#39;t be higher than the maximum.");
    expect(await testDb().select().from(games)).toHaveLength(0);
  });

  it("shows the odd-max warning without refusing the game", async () => {
    const { cookie } = await signIn();
    const response = await post("/g/new", cookie, { ...VALID, maxPlayers: "13" });
    expect(response.status).toBe(303);
  });

  /**
   * The 422 page reflects raw, attacker-chosen form fields (`name`,
   * `venueName`, `venueAddress`, …) straight back into `value="..."`
   * attributes — the one branch of this route that renders user input at
   * all, and so the one this route's `no password field / no un-enumerated
   * script` coverage actually has to prove, not merely assert by reference
   * to a shared template. Mirrors the `pages` loop's own checks in
   * `test/routes/signin.test.ts`. This is what backs the `POST /g/new`
   * exclusion in that file's `pinRoutesToPages` — see the reason recorded
   * there.
   */
  it("escapes markup and quote-breakout attempts in a rejected submission rather than reflecting them live", async () => {
    const { cookie } = await signIn();
    const response = await post("/g/new", cookie, {
      ...VALID,
      // Bad enough to be rejected (min > max), so the 422 branch renders —
      // and every string field below is redisplayed via `values`.
      minPlayers: "20",
      name: `"><script>alert(1)</script>`,
      venueName: `Bob's Pitch`,
    });

    expect(response.status).toBe(422);
    const html = await response.text();

    expect(html, "must not contain a password field").not.toMatch(/type=.?password/i);

    // The injected markup must come back escaped, not live: no new <script>
    // tag introduced by the submission, and the raw payload does not appear
    // unescaped anywhere in the page.
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain(`"><script>`);
    expect(html).toContain("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("Bob&#39;s Pitch");

    // Every <script> tag actually on the page — none introduced by this
    // submission — must be a bare, attribute-free tag whose text is a member
    // of `SCRIPT_BLOCKS`, exactly as the signin.test.ts pages loop requires,
    // so nothing here can carry a script the CSP hasn't hashed.
    for (const [, attributes, js] of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
      expect(attributes, "any script tag on this page must carry no attributes").toBe("");
      expect(
        SCRIPT_BLOCKS as readonly string[],
        "any script tag on this page must be a member of SCRIPT_BLOCKS",
      ).toContain(js);
    }

    expect(await testDb().select().from(games)).toHaveLength(0);
  });

  /**
   * Proves the doc comment on `createGame` (src/domain/create-game.ts): a
   * materialisation failure must not turn an already-committed game into a
   * 500 the owner never sees a redirect from. Forces the failure by
   * intercepting the `fixtures` insert with `interferingBinding` rather than
   * crafting bad input — `parseGameForm` can never produce a `recurrenceRule`
   * that fails to parse, so the only way to exercise this branch through the
   * real route is to make the write itself fail.
   */
  it("still redirects to the new game when fixture materialisation fails", async () => {
    const { cookie } = await signIn();
    const app = createApp();

    const failing = interferingBinding(env.DB, {
      match: /insert into "fixtures"/i,
      before: async () => {
        throw new Error("simulated D1 failure while inserting fixtures");
      },
    });

    const response = await app.fetch(
      new Request(`${ORIGIN}/g/new`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie },
        body: new URLSearchParams(VALID),
      }),
      bindings({ DB: failing }),
    );

    expect(response.status).toBe(303);
    const location = response.headers.get("location")!;
    expect(location).toMatch(/^\/g\/[0-9a-f-]{36}$/);

    // The game itself is there even though no fixtures are (the daily sweep
    // fills those in) — the write was not lost.
    const [game] = await testDb().select().from(games);
    expect(game?.name).toBe("Thursday 7-a-side");
    expect(location).toBe(`/g/${game!.id}`);
  });

  it("refuses a cross-site form post", async () => {
    const { cookie } = await signIn();
    const response = await SELF.fetch(`${ORIGIN}/g/new`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example", cookie },
      body: new URLSearchParams(VALID),
      redirect: "manual",
    });
    expect(response.status).toBe(403);
    expect(await testDb().select().from(games)).toHaveLength(0);
  });

  it("refuses an anonymous post", async () => {
    const response = await SELF.fetch(`${ORIGIN}/g/new`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
      body: new URLSearchParams(VALID),
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(await testDb().select().from(games)).toHaveLength(0);
  });
});
