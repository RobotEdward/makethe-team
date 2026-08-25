import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { ADMIN_PATH, ADMIN_USAGE_PATH, SIGN_IN_PATH } from "../../src/auth/paths.js";
import { getDb } from "../../src/db/client.js";
import { user } from "../../src/db/schema.js";
import { NOW } from "../support/clock.js";
import {
  insertFixture,
  insertGame,
  insertMembership,
  insertPlayer,
  insertResponse,
  resetDatabase,
} from "../support/factories.js";
import { ALLOWED, ORIGIN, bindings, signIn } from "../support/sign-in.js";

const db = getDb(env.DB);

async function signInAs({ admin }: { admin: boolean }) {
  const { cookie } = await signIn();
  if (admin) {
    await db.update(user).set({ isAdmin: true }).where(eq(user.email, ALLOWED));
  }
  return cookie;
}

function usageRequest(cookie: string) {
  return new Request(`${ORIGIN}${ADMIN_USAGE_PATH}`, { headers: { cookie } });
}

describe("the admin usage screen", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("redirects an anonymous visitor to sign-in", async () => {
    const response = await createApp().fetch(new Request(`${ORIGIN}${ADMIN_USAGE_PATH}`), bindings());
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(SIGN_IN_PATH);
  });

  it("answers 404, not 403, to a signed-in non-admin", async () => {
    const cookie = await signInAs({ admin: false });
    const response = await createApp().fetch(usageRequest(cookie), bindings());
    expect(response.status).toBe(404);
  });

  it("renders for an admin against an empty database", async () => {
    const cookie = await signInAs({ admin: true });
    const response = await createApp().fetch(usageRequest(cookie), bindings());

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Usage");
    expect(html).toContain("No games yet");
  });

  it("counts real data and names the game", async () => {
    const cookie = await signInAs({ admin: true });
    const gameId = await insertGame(db, { name: "Thursday 7-a-side" });
    const fixtureId = await insertFixture(db, gameId, {
      kicksOffAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
      inCount: 10,
      minPlayers: 10,
    });
    const playerId = await insertPlayer(db);
    await insertMembership(db, gameId, playerId);
    await insertResponse(db, fixtureId, playerId, { status: "in", respondedAt: NOW });

    const response = await createApp().fetch(usageRequest(cookie), bindings());
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Thursday 7-a-side");
    expect(html).not.toContain("No games yet");
  });

  it("shows today's sends against the configured ceiling", async () => {
    const cookie = await signInAs({ admin: true });
    const response = await createApp().fetch(usageRequest(cookie), bindings());
    expect(await response.text()).toContain("of 80");
  });

  it("is linked from the admin index", async () => {
    const cookie = await signInAs({ admin: true });
    const response = await createApp().fetch(
      new Request(`${ORIGIN}${ADMIN_PATH}`, { headers: { cookie } }),
      bindings(),
    );
    expect(await response.text()).toContain(`href="${ADMIN_USAGE_PATH}"`);
  });
});
