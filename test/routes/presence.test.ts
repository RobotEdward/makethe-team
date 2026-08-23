import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { DASHBOARD_PATH, PRESENCE_PATH } from "../../src/auth/paths.js";
import { getDb } from "../../src/db/client.js";
import { players } from "../../src/db/schema.js";
import { PRESENCE_STAMP_INTERVAL_MS } from "../../src/domain/presence.js";
import { resetDatabase } from "../support/factories.js";
import { ALLOWED, ORIGIN, bindings, signIn } from "../support/sign-in.js";

const db = getDb(env.DB);

beforeEach(async () => {
  await resetDatabase();
});

function ping(
  cookie: string | undefined,
  body: unknown,
  origin: string | null = ORIGIN,
): Promise<Response> {
  return Promise.resolve(
    createApp().fetch(
      new Request(`${ORIGIN}${PRESENCE_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(cookie ? { cookie } : {}),
          ...(origin ? { origin } : {}),
        },
        body: JSON.stringify(body),
      }),
      bindings(),
    ),
  );
}

async function viewer() {
  const [player] = await db.select().from(players).where(eq(players.email, ALLOWED));
  expect(player).toBeDefined();
  return player!;
}

describe("POST /app/presence (M33)", () => {
  it("stamps the signed-in player as seen", async () => {
    const { cookie } = await signIn();

    const response = await ping(cookie, { standalone: false });

    expect(response.status).toBe(204);
    expect((await viewer()).lastSeenAt).not.toBeNull();
  });

  it("leaves the installed stamp alone when the page is an ordinary tab", async () => {
    const { cookie } = await signIn();

    await ping(cookie, { standalone: false });

    expect((await viewer()).lastStandaloneAt).toBeNull();
  });

  it("records the installed app when the page says it is one", async () => {
    const { cookie } = await signIn();

    await ping(cookie, { standalone: true });

    expect((await viewer()).lastStandaloneAt).not.toBeNull();
  });

  it("does not write again inside the throttle interval", async () => {
    const { cookie } = await signIn();
    await ping(cookie, { standalone: false });
    const first = (await viewer()).lastSeenAt;
    expect(first).not.toBeNull();

    await ping(cookie, { standalone: false });

    expect((await viewer()).lastSeenAt).toEqual(first);
  });

  it("writes again once the stamp is older than the interval", async () => {
    const { cookie } = await signIn();
    const stale = new Date(Date.now() - (PRESENCE_STAMP_INTERVAL_MS + 60_000));
    await db.update(players).set({ lastSeenAt: stale }).where(eq(players.email, ALLOWED));

    await ping(cookie, { standalone: false });

    expect((await viewer()).lastSeenAt?.getTime()).toBeGreaterThan(stale.getTime());
  });

  // The page pings without knowing whether its session is still good. A 401
  // here would be a console error on a page that is working perfectly, and
  // nothing about an anonymous caller is worth recording.
  it("answers a caller with no session, and records nothing", async () => {
    const response = await ping(undefined, { standalone: true });

    expect(response.status).toBe(204);
    const rows = await db.select().from(players);
    expect(rows.every((row) => row.lastSeenAt === null)).toBe(true);
  });

  it("refuses a cross-origin post", async () => {
    const { cookie } = await signIn();

    const response = await ping(cookie, { standalone: true }, "https://evil.example");

    expect(response.status).toBe(403);
    expect((await viewer()).lastSeenAt).toBeNull();
  });

  // A body that is not what the script sends is still a page load by a
  // signed-in player, which is the whole fact this route exists to record.
  // Only `standalone === true` claims the installed app.
  it("treats an unreadable body as an ordinary page load rather than an error", async () => {
    const { cookie } = await signIn();

    const response = await createApp().fetch(
      new Request(`${ORIGIN}${PRESENCE_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: ORIGIN },
        body: "not json at all",
      }),
      bindings(),
    );

    expect(response.status).toBe(204);
    const player = await viewer();
    expect(player.lastSeenAt).not.toBeNull();
    expect(player.lastStandaloneAt).toBeNull();
  });

  it("does not treat a string 'true' as the installed app", async () => {
    const { cookie } = await signIn();

    await ping(cookie, { standalone: "true" });

    expect((await viewer()).lastStandaloneAt).toBeNull();
  });

  it("is reachable only by POST", async () => {
    const { cookie } = await signIn();

    const response = await createApp().fetch(
      new Request(`${ORIGIN}${PRESENCE_PATH}`, { headers: { cookie } }),
      bindings(),
    );

    expect(response.status).not.toBe(204);
  });

  it("is under the dashboard prefix, so the session mount covers it", () => {
    expect(PRESENCE_PATH.startsWith(`${DASHBOARD_PATH}/`)).toBe(true);
  });
});
