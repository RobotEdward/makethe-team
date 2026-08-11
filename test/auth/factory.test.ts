import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createAuth } from "../../src/auth/factory.js";
import { getDb } from "../../src/db/client.js";
import { user as userTable } from "../../src/db/schema.js";

/**
 * The deciding test for this task: create a record through Better Auth's
 * own API (its resolved adapter, via `auth.$context`) and read it back with
 * our own Drizzle instance. If this does not round-trip, the Drizzle
 * adapter is not genuinely talking to D1 and nothing in this milestone can
 * be safely built on top of it.
 *
 * No plugin (magic link, credential, passkey) is configured yet — that's
 * later tasks — so `ctx.adapter.create` for the base "user" model is the
 * only Better Auth API surface available here. It is still Better Auth's
 * own code: `betterAuth()` -> `drizzleAdapter(db, ...)` -> the adapter
 * factory's `create`, not a raw `db.insert(...)` we wrote ourselves.
 */
describe("createAuth", () => {
  it("round-trips a record created through Better Auth's adapter API and read back with Drizzle", async () => {
    const db = getDb(env.DB);
    const auth = createAuth(
      { ...env, BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET, BETTER_AUTH_URL: "http://localhost:8787" },
      db,
    );

    const ctx = await auth.$context;
    const created = await ctx.adapter.create<{
      id: string;
      name: string;
      email: string;
      emailVerified: boolean;
    }>({
      model: "user",
      data: {
        name: "Ada Lovelace",
        email: "ada@example.com",
        emailVerified: false,
      },
    });

    expect(created.id).toBeTruthy();
    expect(created.email).toBe("ada@example.com");

    const rows = await db.select().from(userTable).where(eq(userTable.id, created.id));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.email).toBe("ada@example.com");
    expect(rows[0]?.name).toBe("Ada Lovelace");
    expect(rows[0]?.emailVerified).toBe(false);
  });

  it("constructs a fresh instance per call rather than sharing state", () => {
    const db = getDb(env.DB);
    const authA = createAuth({ ...env, BETTER_AUTH_URL: "http://localhost:8787" }, db);
    const authB = createAuth({ ...env, BETTER_AUTH_URL: "http://localhost:8787" }, db);
    expect(authA).not.toBe(authB);
  });
});
