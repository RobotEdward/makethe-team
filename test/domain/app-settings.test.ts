import { beforeEach, describe, expect, it } from "vitest";
import { isOpenSignups, setOpenSignups } from "../../src/domain/app-settings.js";
import { appSettings } from "../../src/db/schema.js";
import { resetDatabase, testDb } from "../support/factories.js";

/**
 * The operator's open-sign-ups switch (M30), read as the fourth door of the
 * sign-in gate. Every case here is about the same property: the switch is
 * **off** unless the row says exactly `"on"`.
 *
 * That matters more than a normal default. This is the one setting whose
 * wrong-way failure opens a trial-only site to the whole internet silently,
 * whereas failing closed is reported by the first person who cannot sign in —
 * the same reasoning `isSignInAllowlisted` records for a missing secret.
 */
describe("isOpenSignups", () => {
  const db = testDb();

  beforeEach(async () => {
    await resetDatabase();
  });

  it("is off when no row has ever been written", async () => {
    expect(await isOpenSignups(db)).toBe(false);
  });

  it("is on once the operator turns it on", async () => {
    await setOpenSignups(db, true);
    expect(await isOpenSignups(db)).toBe(true);
  });

  it("is off again once the operator turns it back off", async () => {
    await setOpenSignups(db, true);
    await setOpenSignups(db, false);
    expect(await isOpenSignups(db)).toBe(false);
  });

  it("survives being turned on twice without a duplicate-key error", async () => {
    await setOpenSignups(db, true);
    await setOpenSignups(db, true);
    expect(await isOpenSignups(db)).toBe(true);
  });

  /**
   * `app_settings.value` is a bare `text NOT NULL` with no CHECK constraint,
   * so a value this build has never heard of is a row the schema permits.
   * Anything that is not exactly `"on"` must read as off.
   */
  it.each(["off", "ON", "true", "1", "yes", "", " on "])(
    "reads the stored value %o as off",
    async (stored) => {
      await db.insert(appSettings).values({ key: "open_signups", value: stored });
      expect(await isOpenSignups(db)).toBe(false);
    },
  );

  it("ignores rows for other settings", async () => {
    await db.insert(appSettings).values({ key: "something_else", value: "on" });
    expect(await isOpenSignups(db)).toBe(false);
  });
});
