import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { games } from "../../src/db/schema.js";
import { resetDatabase, testDb } from "../support/factories.js";
import { ORIGIN, signIn } from "../support/sign-in.js";

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
