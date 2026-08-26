import { env, SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb, type Db } from "../../src/db/client.js";
import { fixtures, gameNotificationSettings, memberships, players, responses } from "../../src/db/schema.js";
import { sendOwnerAttention } from "../../src/sweep/attention.js";
import { sendGroupNudges } from "../../src/sweep/group-nudge.js";
import { openAndRemind } from "../../src/sweep/open-and-remind.js";
import { NOTIFICATION_CONTROLS, cellsWithScope } from "../../src/notify/notification-controls.js";
import { loadNotificationSettings } from "../../src/notify/notification-settings.js";
import { sendBroadcast } from "../../src/notify/send-broadcast.js";
import { sendPickerHandover } from "../../src/notify/send-picker-handover.js";
import { sendRemovedEmail } from "../../src/notify/send-removed.js";
import { sendResultNudges } from "../../src/notify/send-result-nudge.js";
import { sendWelcomeEmail } from "../../src/notify/send-welcome.js";
import type { Channel, Message, Notifier, SendResult } from "../../src/notify/notifier.js";
import { sendTeamsEmails } from "../../src/notify/send-teams.js";
import type { NotificationType } from "../../src/notify/dedupe-key.js";
import {
  insertGame,
  insertNotificationSetting,
  insertSubscription,
  resetDatabase,
  setAdminSwitch,
} from "../support/factories.js";
import { ORIGIN, signIn } from "../support/sign-in.js";

const db = getDb(env.DB);

/**
 * Task zero (spec §7): the enumerating invariant tests, driven off
 * `NOTIFICATION_CONTROLS` rather than hand-picked cases, so a type added to
 * the catalogue with an owner or administrator scope is caught here before
 * anyone writes its send-path test. Written before any send path consults
 * `loadNotificationSettings` (Tasks 4-8 do that one type at a time), so every
 * "sends nothing" case below is expected to fail until its type converts —
 * that is the point of writing it now rather than after.
 */

const SECRET = "test-secret";

interface Driver {
  /** Seeds a game, a recipient with both an email and a registered device, and whatever the send path needs. Returns the game id. */
  seed(db: Db): Promise<string>;
  /** Runs the send path once against a recording notifier. */
  send(db: Db, gameId: string, notifier: Notifier): Promise<void>;
}

/** Records `message.channel` for every message it is handed, and answers ok for all of them. */
function recording(): { notifier: Notifier; channels: Channel[] } {
  const channels: Channel[] = [];
  const notifier: Notifier = {
    send(messages: readonly Message[]): Promise<SendResult[]> {
      for (const message of messages) channels.push(message.channel);
      return Promise.resolve(messages.map((): SendResult => ({ ok: true, providerMessageId: null })));
    },
  };
  return { notifier, channels };
}

/** The one fixture a driver's `seed` created for this game. Every driver here seeds exactly one. */
async function soleFixtureId(db: Db, gameId: string): Promise<string> {
  const [row] = await db.select({ id: fixtures.id }).from(fixtures).where(eq(fixtures.gameId, gameId));
  if (!row) throw new Error(`notification-invariants: no fixture found for game ${gameId}`);
  return row.id;
}

// --- n1: openAndRemind (test/sweep/open-and-remind.test.ts) ---

const N1_KICKOFF = new Date("2026-08-13T18:00:00Z");
const N1_NOW = new Date("2026-08-12T09:00:00Z"); // past the 08:00Z reminder instant

const n1Driver: Driver = {
  async seed(db) {
    const gameId = await insertGame(db, {
      timezone: "Europe/London",
      reminderDaysBefore: 1,
      reminderLocalTime: "09:00",
      reminderEnabled: true,
    });
    const fixtureId = crypto.randomUUID();
    await db.insert(fixtures).values({
      id: fixtureId,
      gameId,
      kicksOffAt: N1_KICKOFF,
      lifecycle: "open",
      minPlayers: 10,
      maxPlayers: 14,
      prefersEvenNumbers: true,
      shortWarningOffsetHours: 12,
      durationMinutes: 60,
    });
    const playerId = "n1-player";
    await db.insert(players).values({ id: playerId, name: "Player", email: "n1-player@example.com" });
    await db.insert(memberships).values({ id: "n1-m", gameId, playerId, role: "player", active: true });
    // `eligiblePlayers` reads candidates off `responses`, not `memberships` —
    // BR-2 backfills this row when a real fixture opens (`openFixture`), which
    // this seed bypasses in favour of inserting the fixture already `open`.
    await db.insert(responses).values({ id: "n1-r", fixtureId, playerId, status: "pending", source: "system" });
    await insertSubscription(db, playerId, "https://push.example.com/n1-player");
    return gameId;
  },
  async send(db, _gameId, notifier) {
    await openAndRemind(db, notifier, N1_NOW, SECRET, env.FIXTURE_CAPACITY);
  },
};

// --- n4: sendOwnerAttention (test/sweep/attention.test.ts) ---

const N4_KICKOFF = new Date("2026-08-13T18:00:00Z"); // 9h after N4_NOW: inside the 12h warning window
const N4_NOW = new Date("2026-08-13T09:00:00Z");

const n4Driver: Driver = {
  async seed(db) {
    const gameId = await insertGame(db, {
      prefersEvenNumbers: true,
      minPlayers: 10,
      maxPlayers: 14,
      shortWarningEnabled: true,
    });
    const fixtureId = crypto.randomUUID();
    await db.insert(fixtures).values({
      id: fixtureId,
      gameId,
      kicksOffAt: N4_KICKOFF,
      lifecycle: "open",
      minPlayers: 10,
      maxPlayers: 14,
      prefersEvenNumbers: true,
      shortWarningOffsetHours: 12,
      durationMinutes: 60,
      inCount: 8, // 2 short of minPlayers, inside the window: fires
    });
    for (let i = 0; i < 8; i++) {
      const playerId = `n4-in-${i}`;
      await db.insert(players).values({ id: playerId, name: `In ${i}`, email: `${playerId}@example.com` });
      await db.insert(memberships).values({ id: `n4-m-${i}`, gameId, playerId, role: "player", active: true });
      await db.insert(responses).values({ id: `n4-r-${i}`, fixtureId, playerId, status: "in", source: "token" });
    }
    const ownerId = "n4-owner";
    await db.insert(players).values({ id: ownerId, name: "Owner", email: "n4-owner@example.com" });
    await db.insert(memberships).values({ id: "n4-owner-m", gameId, playerId: ownerId, role: "owner", active: true });
    await insertSubscription(db, ownerId, "https://push.example.com/n4-owner");
    return gameId;
  },
  async send(db, _gameId, notifier) {
    await sendOwnerAttention({ db, notifier, now: N4_NOW, cancelTokenSecret: SECRET, ceilingReached: false });
  },
};

// --- n9: sendTeamsEmails (test/notify/send-teams.test.ts) ---

const N9_KICKOFF = new Date("2026-08-13T18:00:00Z");
const N9_NOW = new Date("2026-08-12T09:05:00Z");

const n9Driver: Driver = {
  async seed(db) {
    const gameId = await insertGame(db, { name: "Thursday 7-a-side", venueName: "Oxford Sports Park" });
    const fixtureId = crypto.randomUUID();
    await db.insert(fixtures).values({
      id: fixtureId,
      gameId,
      kicksOffAt: N9_KICKOFF,
      lifecycle: "open",
      minPlayers: 2,
      maxPlayers: 14,
      prefersEvenNumbers: true,
      shortWarningOffsetHours: 12,
      durationMinutes: 60,
    });
    const playerId = "n9-player";
    await db.insert(players).values({ id: playerId, name: "Alice", email: "n9-player@example.com", isGuest: false });
    await db.insert(memberships).values({ id: "n9-m", gameId, playerId, active: true });
    await db.insert(responses).values({ id: "n9-r", fixtureId, playerId, status: "in", source: "token", team: "a" });
    await insertSubscription(db, playerId, "https://push.example.com/n9-player");
    return gameId;
  },
  async send(db, gameId, notifier) {
    const fixtureId = await soleFixtureId(db, gameId);
    await sendTeamsEmails({ db, notifier, fixtureId, publishedAt: N9_NOW, now: N9_NOW, responseTokenSecret: SECRET });
  },
};

// --- n11: sendGroupNudges (test/sweep/group-nudge.test.ts) ---

const N11_KICKOFF = new Date("2026-08-13T18:00:00Z");
const N11_DUE_NOW = new Date("2026-08-12T10:00:00Z"); // past the 08:00Z reminder instant

const n11Driver: Driver = {
  async seed(db) {
    const gameId = await insertGame(db, { name: "Thursday 7-a-side", groupNudgeEnabled: true });
    const fixtureId = crypto.randomUUID();
    await db.insert(fixtures).values({
      id: fixtureId,
      gameId,
      kicksOffAt: N11_KICKOFF,
      lifecycle: "open",
      minPlayers: 10,
      maxPlayers: 14,
      prefersEvenNumbers: true,
      shortWarningOffsetHours: 12,
      durationMinutes: 60,
      inCount: 7,
    });
    const ownerId = "n11-owner";
    await db.insert(players).values({ id: ownerId, name: "Owner", email: "n11-owner@example.com" });
    await db.insert(memberships).values({ id: "n11-owner-m", gameId, playerId: ownerId, role: "owner", active: true });
    await insertSubscription(db, ownerId, "https://push.example.com/n11-owner");
    return gameId;
  },
  async send(db, _gameId, notifier) {
    await sendGroupNudges(db, notifier, N11_DUE_NOW);
  },
};

// --- n12: sendResultNudges (test/notify/result-nudge.test.ts) ---

const N12_KICKOFF = new Date("2026-08-13T19:00:00Z");
const N12_DURATION_MINUTES = 60;
const N12_FULL_TIME = new Date(N12_KICKOFF.getTime() + N12_DURATION_MINUTES * 60_000);
const N12_NOW = new Date(N12_FULL_TIME.getTime() + 60 * 60 * 1000); // 1h after full time: inside the 12h window

// n12's own send path is push-preferred/email-fallback *per player*: a
// single recipient who has both a device and an email always takes the push
// branch and never reaches the email one, so with only that recipient the
// email cell could never fail no matter what the switches do. A second
// recipient with an email and no device is the only way to give the email
// leg a player who can actually carry it.
const n12Driver: Driver = {
  async seed(db) {
    const gameId = await insertGame(db);
    const devicePlayerId = "n12-player";
    const emailOnlyPlayerId = "n12-email-only-player";
    // Both channels: push is preferred when both are present on one player.
    await db.insert(players).values({ id: devicePlayerId, name: "Both Channels", email: "n12-player@example.com" });
    await db.insert(memberships).values({ id: "n12-m", gameId, playerId: devicePlayerId, active: true });
    await insertSubscription(db, devicePlayerId, "https://push.example.com/n12-player");
    // Email only, no device: the recipient the email leg is actually
    // observable through.
    await db
      .insert(players)
      .values({ id: emailOnlyPlayerId, name: "Email Only", email: "n12-email-only@example.com" });
    await db.insert(memberships).values({ id: "n12-email-only-m", gameId, playerId: emailOnlyPlayerId, active: true });
    const fixtureId = crypto.randomUUID();
    await db.insert(fixtures).values({
      id: fixtureId,
      gameId,
      kicksOffAt: N12_KICKOFF,
      lifecycle: "played",
      minPlayers: 2,
      maxPlayers: 14,
      prefersEvenNumbers: true,
      shortWarningOffsetHours: 12,
      durationMinutes: N12_DURATION_MINUTES,
    });
    await db.insert(responses).values({ id: "n12-r", fixtureId, playerId: devicePlayerId, status: "in", source: "token" });
    await db
      .insert(responses)
      .values({ id: "n12-r-email-only", fixtureId, playerId: emailOnlyPlayerId, status: "in", source: "token" });
    return gameId;
  },
  async send(db, _gameId, notifier) {
    await sendResultNudges(db, notifier, N12_NOW, SECRET);
  },
};

// --- n13: sendPickerHandover (test/notify/send-picker-handover.test.ts) ---

const N13_KICKOFF = new Date("2026-08-13T18:00:00Z");
const N13_SET_AT = new Date("2026-08-12T08:55:00Z");
const N13_NOW = new Date("2026-08-12T09:00:00Z");
const N13_DELEGATE_ID = "n13-delegate";

const n13Driver: Driver = {
  async seed(db) {
    const gameId = await insertGame(db, { name: "Thursday 7-a-side", venueName: "Oxford Sports Park" });
    await db.insert(players).values({
      id: N13_DELEGATE_ID,
      name: "Dee Delegate",
      email: "n13-delegate@example.com",
    });
    await db.insert(memberships).values({ id: "n13-m", gameId, playerId: N13_DELEGATE_ID, active: true });
    await insertSubscription(db, N13_DELEGATE_ID, "https://push.example.com/n13-delegate");
    const fixtureId = crypto.randomUUID();
    await db.insert(fixtures).values({
      id: fixtureId,
      gameId,
      kicksOffAt: N13_KICKOFF,
      lifecycle: "open",
      minPlayers: 2,
      maxPlayers: 14,
      prefersEvenNumbers: true,
      shortWarningOffsetHours: 12,
      durationMinutes: 60,
      pickerMode: "delegate",
      teamPickerPlayerId: N13_DELEGATE_ID,
      teamPickerSetAt: N13_SET_AT,
    });
    return gameId;
  },
  async send(db, gameId, notifier) {
    const fixtureId = await soleFixtureId(db, gameId);
    await sendPickerHandover({
      db,
      notifier,
      fixtureId,
      playerId: N13_DELEGATE_ID,
      setAt: N13_SET_AT,
      now: N13_NOW,
      responseTokenSecret: SECRET,
    });
  },
};

// --- n6: sendWelcomeEmail (test/notify/send-welcome.test.ts) ---

const N6_JOINED_AT = new Date("2026-08-12T09:00:00Z");
const N6_NOW = N6_JOINED_AT;
const N6_PLAYER_ID = "n6-player";
const N6_MEMBERSHIP_ID = "n6-m";

const n6Driver: Driver = {
  async seed(db) {
    const gameId = await insertGame(db, { name: "Thursday 7-a-side", venueName: "Oxford Sports Park" });
    await db.insert(players).values({ id: N6_PLAYER_ID, name: "Alex", email: "n6-player@example.com" });
    await db
      .insert(memberships)
      .values({ id: N6_MEMBERSHIP_ID, gameId, playerId: N6_PLAYER_ID, active: true, joinedAt: N6_JOINED_AT });
    await insertSubscription(db, N6_PLAYER_ID, "https://push.example.com/n6-player");
    return gameId;
  },
  async send(db, gameId, notifier) {
    await sendWelcomeEmail({
      db,
      notifier,
      gameId,
      playerId: N6_PLAYER_ID,
      membershipId: N6_MEMBERSHIP_ID,
      joinedAt: N6_JOINED_AT,
      now: N6_NOW,
      responseTokenSecret: SECRET,
    });
  },
};

// --- n7: sendRemovedEmail (test/notify/send-removed.test.ts) ---

const N7_LEFT_AT = new Date("2026-08-13T11:59:00Z");
const N7_NOW = new Date("2026-08-13T12:00:00Z");
const N7_PLAYER_ID = "n7-player";

const n7Driver: Driver = {
  async seed(db) {
    const gameId = await insertGame(db, { name: "Thursday 7-a-side" });
    await db.insert(players).values({ id: N7_PLAYER_ID, name: "Sam Okafor", email: "n7-player@example.com" });
    await insertSubscription(db, N7_PLAYER_ID, "https://push.example.com/n7-player");
    return gameId;
  },
  async send(db, gameId, notifier) {
    await sendRemovedEmail({
      db,
      notifier,
      gameId,
      playerId: N7_PLAYER_ID,
      membershipId: "n7-m",
      leftAt: N7_LEFT_AT,
      now: N7_NOW,
    });
  },
};

// --- n10: sendBroadcast (test/notify/send-broadcast.test.ts) — both channels ---

const N10_KICKOFF = new Date("2026-08-13T18:00:00Z");
const N10_NOW = new Date("2026-08-12T09:00:00Z");

const n10Driver: Driver = {
  async seed(db) {
    const gameId = await insertGame(db, { name: "Thursday 7-a-side", venueName: "Oxford Sports Park" });
    const fixtureId = crypto.randomUUID();
    await db.insert(fixtures).values({
      id: fixtureId,
      gameId,
      kicksOffAt: N10_KICKOFF,
      lifecycle: "open",
      minPlayers: 2,
      maxPlayers: 14,
      prefersEvenNumbers: true,
      shortWarningOffsetHours: 12,
      durationMinutes: 60,
    });
    const playerId = "n10-player";
    await db.insert(players).values({ id: playerId, name: "Alice", email: "n10-player@example.com" });
    await db.insert(memberships).values({ id: "n10-m", gameId, playerId, active: true });
    await db.insert(responses).values({ id: "n10-r", fixtureId, playerId, status: "in", source: "token" });
    await insertSubscription(db, playerId, "https://push.example.com/n10-player");
    return gameId;
  },
  async send(db, gameId, notifier) {
    const fixtureId = await soleFixtureId(db, gameId);
    await sendBroadcast({
      db,
      notifier,
      broadcastId: "invariant-bc",
      gameId,
      fixtureId,
      audience: "playing",
      subject: "Pitch has moved",
      message: "We're on the 3G pitch this week.",
      organiserName: "Jamie",
      channels: { email: true, push: true },
      now: N10_NOW,
      responseTokenSecret: SECRET,
    });
  },
};

const DRIVERS: Partial<Record<NotificationType, Driver>> = {
  n1: n1Driver,
  n4: n4Driver,
  n6: n6Driver,
  n7: n7Driver,
  n9: n9Driver,
  n10: n10Driver,
  n11: n11Driver,
  n12: n12Driver,
  n13: n13Driver,
};

function driverFor(type: NotificationType): Driver {
  const driver = DRIVERS[type];
  if (!driver) throw new Error(`notification-invariants: no driver registered for ${type}`);
  return driver;
}

beforeEach(async () => {
  await resetDatabase();
});

describe("invariant 1: every owner cell is enforced, per channel", () => {
  for (const cell of cellsWithScope("owner")) {
    const control = NOTIFICATION_CONTROLS[cell.type];
    const other = control.channels.find((c) => c !== cell.channel);
    it(`${cell.type}: owner off on ${cell.channel} sends nothing on ${cell.channel}${other ? ` while ${other} still goes` : ""}`, async () => {
      const gameId = await driverFor(cell.type).seed(db);
      await insertNotificationSetting(db, gameId, cell.type, cell.channel, false);
      const sent = recording();
      await driverFor(cell.type).send(db, gameId, sent.notifier);
      expect(sent.channels).not.toContain(cell.channel);
      if (other) expect(sent.channels).toContain(other);
    });
  }
});

describe("invariant 2: the administrator masks, never overwrites", () => {
  for (const cell of [...cellsWithScope("owner"), ...cellsWithScope("admin")]) {
    it(`${cell.type}.${cell.channel}: admin off sends nothing on that channel whatever the owner says`, async () => {
      const gameId = await driverFor(cell.type).seed(db);
      if (NOTIFICATION_CONTROLS[cell.type].scope === "owner") {
        await insertNotificationSetting(db, gameId, cell.type, cell.channel, true);
      }
      await setAdminSwitch(db, cell.type, cell.channel, false);
      const sent = recording();
      await driverFor(cell.type).send(db, gameId, sent.notifier);
      expect(sent.channels).not.toContain(cell.channel);
    });
  }

  for (const cell of cellsWithScope("owner")) {
    it(`${cell.type}.${cell.channel}: the owner's row is byte-identical after admin off then on`, async () => {
      const gameId = await insertGame(db);
      await insertNotificationSetting(db, gameId, cell.type, cell.channel, false);
      const before = await db.select().from(gameNotificationSettings).where(eq(gameNotificationSettings.gameId, gameId));
      await setAdminSwitch(db, cell.type, cell.channel, false);
      await setAdminSwitch(db, cell.type, cell.channel, true);
      const after = await db.select().from(gameNotificationSettings).where(eq(gameNotificationSettings.gameId, gameId));
      expect(after).toEqual(before);
    });
  }
});

/**
 * Invariant 3, at the form rather than the send path: a browser never posts
 * a disabled field, so an administrator-off cell's checkbox — rendered
 * `disabled`, with no hidden marker — carries nothing back to the server
 * whatever the owner's saved value is or was. `parseNotificationCells`
 * leaves an unmarked cell exactly as stored (its whole reason for existing —
 * see its doc comment in src/domain/game-form.ts). Exercised through the
 * real edit route, not the parser in isolation, because the parser being
 * correct proves nothing if the view ever rendered a marker for a cell it
 * had disabled.
 */
describe("invariant 3: a disabled checkbox posts nothing, and that is not a choice", () => {
  async function post(path: string, cookie: string, fields: Record<string, string>) {
    return SELF.fetch(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie },
      body: new URLSearchParams(fields),
      redirect: "manual",
    });
  }

  /** The minimum a valid create-form submission carries (mirrors test/routes/games.test.ts's VALID). */
  const VALID: Record<string, string> = {
    name: "Thursday 7-a-side",
    venueName: "Oxford Sports Park",
    weekday: "TH",
    interval: "1",
    kickoffTime: "19:00",
    durationMinutes: "60",
    minPlayers: "10",
    maxPlayers: "14",
    prefersEvenNumbers: "on",
    prefersEvenNumbersSubmitted: "1",
    squadVisibleToPlayers: "on",
    squadVisibleToPlayersSubmitted: "1",
  };

  /**
   * Every `<input>` inside the Notifications fieldset of a rendered edit
   * page, as a browser would submit it: a checked checkbox's value, a hidden
   * marker's value, and nothing at all for an unchecked or `disabled` one —
   * regexes rather than a DOM, because the only thing this needs from the
   * markup is exactly what a form submission would send.
   */
  function notificationFieldsFromHtml(html: string): Record<string, string> {
    const start = html.indexOf("<legend>Notifications</legend>");
    const end = html.indexOf("</fieldset>", start);
    if (start === -1 || end === -1) throw new Error("no Notifications fieldset found in the edit page");
    const section = html.slice(start, end);

    const fields: Record<string, string> = {};
    for (const match of section.matchAll(/<input\b([^>]*)>/g)) {
      const attrs = match[1]!;
      const name = attrs.match(/name="([^"]+)"/)?.[1];
      if (!name) continue;
      const type = attrs.match(/type="([^"]+)"/)?.[1] ?? "text";
      if (type === "checkbox") {
        if (/\bchecked\b/.test(attrs)) fields[name] = "on";
        // Unchecked or disabled: a browser sends nothing, so neither does this.
      } else {
        fields[name] = attrs.match(/value="([^"]*)"/)?.[1] ?? "";
      }
    }
    return fields;
  }

  it("leaves an owner's true untouched when the administrator has the cell off and the owner saves the form", async () => {
    const { cookie } = await signIn();
    const created = await post("/g/new", cookie, VALID);
    const gameId = created.headers.get("location")!.replace("/g/", "");

    await insertNotificationSetting(db, gameId, "n9", "email", true);
    await setAdminSwitch(db, "n9", "email", false);

    const editHtml = await (await SELF.fetch(`${ORIGIN}/g/${gameId}/edit`, { headers: { cookie } })).text();
    const notifyFields = notificationFieldsFromHtml(editHtml);

    // n9.email is administrator-disabled: its checkbox must have contributed
    // neither a value nor a marker, whatever the owner's stored `true` says.
    expect(notifyFields["notify.n9.email"]).toBeUndefined();
    expect(notifyFields["notify.n9.email.seen"]).toBeUndefined();

    // n9.push is administrator-allowed and defaults on; the owner unticks it
    // here (deleting the value while its marker survives), which is what a
    // real uncheck looks like in the posted body.
    delete notifyFields["notify.n9.push"];

    const response = await post(`/g/${gameId}/edit`, cookie, { ...VALID, ...notifyFields });
    expect(response.status).toBe(303);

    const settings = await loadNotificationSettings(db, [gameId]);
    expect(settings.ownerWants(gameId, "n9", "email")).toBe(true);
    expect(settings.ownerWants(gameId, "n9", "push")).toBe(false);
  });
});
