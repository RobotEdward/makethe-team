import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadNotificationSettings, saveOwnerNotificationSettings } from "../../src/notify/notification-settings.js";
import { cellsWithScope } from "../../src/notify/notification-controls.js";
import { insertGame, insertNotificationSetting, resetDatabase, setAdminSwitch, testDb } from "../support/factories.js";

const db = testDb();

describe("loadNotificationSettings", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("answers on for every owner cell of a game with no rows", async () => {
    const gameId = await insertGame(db);
    const settings = await loadNotificationSettings(db, [gameId]);
    for (const cell of cellsWithScope("owner")) {
      expect(settings.isEnabled(gameId, cell.type, cell.channel), `${cell.type}.${cell.channel}`).toBe(true);
    }
  });

  it("answers on for every admin cell when nothing has been written", async () => {
    const settings = await loadNotificationSettings(db, []);
    for (const cell of cellsWithScope("admin")) {
      expect(settings.adminAllows(cell.type, cell.channel), `${cell.type}.${cell.channel}`).toBe(true);
    }
  });

  it("honours an owner's off, per channel", async () => {
    const gameId = await insertGame(db);
    await insertNotificationSetting(db, gameId, "n9", "email", false);
    const settings = await loadNotificationSettings(db, [gameId]);
    expect(settings.isEnabled(gameId, "n9", "email")).toBe(false);
    expect(settings.isEnabled(gameId, "n9", "push")).toBe(true);
  });

  it("masks with the administrator's off, and keeps the owner's row underneath", async () => {
    const gameId = await insertGame(db);
    await insertNotificationSetting(db, gameId, "n9", "email", true);
    await setAdminSwitch(db, "n9", "email", false);
    const settings = await loadNotificationSettings(db, [gameId]);
    expect(settings.isEnabled(gameId, "n9", "email")).toBe(false);
    expect(settings.adminAllows("n9", "email")).toBe(false);
    expect(settings.ownerWants(gameId, "n9", "email")).toBe(true);
  });

  it("reads the administrator's off from the exact string 'off' only", async () => {
    // The opposite direction from `isOpenSignups`: an unknown value here
    // means on, because off would silence a notification nobody switched off.
    await setAdminSwitch(db, "n9", "email", false);
    const { appSettings } = await import("../../src/db/schema.js");
    const { eq } = await import("drizzle-orm");
    await db.update(appSettings).set({ value: "disabled" }).where(eq(appSettings.key, "notify.n9.email"));
    const settings = await loadNotificationSettings(db, []);
    expect(settings.adminAllows("n9", "email")).toBe(true);
  });

  it("drops an owner row whose type or channel it does not recognise", async () => {
    const gameId = await insertGame(db);
    await insertNotificationSetting(db, gameId, "n99", "email", false);
    await insertNotificationSetting(db, gameId, "n9", "sms", false);
    const settings = await loadNotificationSettings(db, [gameId]);
    expect(settings.isEnabled(gameId, "n9", "email")).toBe(true);
    expect(settings.isEnabled(gameId, "n9", "push")).toBe(true);
  });

  it("scopes owner rows to their own game", async () => {
    const a = await insertGame(db);
    const b = await insertGame(db);
    await insertNotificationSetting(db, a, "n1", "push", false);
    const settings = await loadNotificationSettings(db, [a, b]);
    expect(settings.isEnabled(a, "n1", "push")).toBe(false);
    expect(settings.isEnabled(b, "n1", "push")).toBe(true);
  });

  it("does no I/O in isEnabled, and no query per game", async () => {
    // The hourly sweep asks about every due fixture; a resolver that touched
    // D1 per fixture would be an N+1 on the hottest path in the product.
    const ids = await Promise.all(Array.from({ length: 30 }, () => insertGame(db)));
    const select = vi.spyOn(db, "select");
    const settings = await loadNotificationSettings(db, ids);
    const loadQueries = select.mock.calls.length;
    // One for app_settings plus ceil(30 / INSERT_CHUNK_SIZE) — far fewer than 30.
    expect(loadQueries).toBeLessThan(ids.length);
    for (const id of ids) settings.isEnabled(id, "n1", "email");
    expect(select.mock.calls.length).toBe(loadQueries);
    select.mockRestore();
  });
});

describe("saveOwnerNotificationSettings", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("upserts each cell and leaves cells it was not given alone", async () => {
    const gameId = await insertGame(db);
    await insertNotificationSetting(db, gameId, "n1", "push", false);
    await saveOwnerNotificationSettings(db, gameId, [
      { type: "n9", channel: "email", enabled: false },
      { type: "n9", channel: "email", enabled: true },
    ]);
    const settings = await loadNotificationSettings(db, [gameId]);
    expect(settings.ownerWants(gameId, "n9", "email")).toBe(true);
    expect(settings.ownerWants(gameId, "n1", "push")).toBe(false);
  });
});
