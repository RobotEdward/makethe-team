import { describe, expect, it } from "vitest";
import { buildTimeline, type AuditRow } from "../../src/domain/timeline.js";

const NAMES: Record<string, string> = { "p-1": "Ada Okafor", "p-2": "Bo Chen" };
const names = (id: string) => NAMES[id] ?? null;

function audit(over: Partial<AuditRow> & Pick<AuditRow, "action" | "createdAt">): AuditRow {
  return { actorPlayerId: null, before: null, after: null, ...over };
}

function at(minutes: number): Date {
  return new Date(Date.UTC(2026, 8, 1, 9, minutes, 0));
}

describe("buildTimeline", () => {
  it("puts the newest thing first, whichever record it came from", () => {
    const entries = buildTimeline({
      audit: [audit({ action: "fixture.opened", createdAt: at(0), after: { pendingCreated: 3, autoDeclined: 0 } })],
      notifications: [
        { notificationType: "n1", playerId: "p-1", channel: "email", status: "sent", sentAt: at(5), createdAt: at(4) },
      ],
      names,
    });

    expect(entries.map((entry) => entry.title)).toEqual(["Invitation sent", "Opened for answers"]);
  });

  it("keeps a stable order when two things share an instant", () => {
    // Opening a fixture writes its audit row and its invitations in one
    // request, so this is the common case, not a corner. A list whose order
    // changed between two loads of the same page reads as a bug.
    const input = {
      audit: [audit({ action: "fixture.opened", createdAt: at(0) })],
      notifications: [
        { notificationType: "n1" as const, playerId: "p-1", channel: "email" as const, status: "sent", sentAt: at(0), createdAt: at(0) },
      ],
      names,
    };

    expect(buildTimeline(input).map((e) => e.title)).toEqual(buildTimeline(input).map((e) => e.title));
  });

  it("distinguishes the sweep from an owner who opened it early", () => {
    const [automatic] = buildTimeline({
      audit: [audit({ action: "fixture.opened", createdAt: at(0) })],
      notifications: [],
      names,
    });
    const [byHand] = buildTimeline({
      audit: [audit({ action: "fixture.opened", createdAt: at(0), actorPlayerId: "p-1" })],
      notifications: [],
      names,
    });

    // The one fact the row exists to carry; the two are otherwise identical.
    expect(automatic?.actor).toBeNull();
    expect(byHand?.actor).toBe("Ada Okafor");
  });

  it("says how many an open asked, and mentions auto-declines only when there were some", () => {
    const [plain] = buildTimeline({
      audit: [audit({ action: "fixture.opened", createdAt: at(0), after: { pendingCreated: 1, autoDeclined: 0 } })],
      notifications: [],
      names,
    });
    const [muted] = buildTimeline({
      audit: [audit({ action: "fixture.opened", createdAt: at(0), after: { pendingCreated: 9, autoDeclined: 2 } })],
      notifications: [],
      names,
    });

    expect(plain?.detail).toBe("1 player asked");
    expect(muted?.detail).toBe("9 players asked, 2 auto-declining");
  });

  it("names the subject of a hand-invite and says the group stays held", () => {
    const [entry] = buildTimeline({
      audit: [audit({ action: "fixture.invited_individually", createdAt: at(0), actorPlayerId: "p-1", after: { playerId: "p-2" } })],
      notifications: [],
      names,
    });

    expect(entry?.actor).toBe("Ada Okafor");
    expect(entry?.subject).toBe("Bo Chen");
    expect(entry?.detail).toBe("Their group stays held.");
  });

  it("shows a change of mind, and stays quiet about a first answer", () => {
    const [changed] = buildTimeline({
      audit: [audit({ action: "fixture.response_recorded", createdAt: at(0), actorPlayerId: "p-1", before: { status: "in" }, after: { status: "out" } })],
      notifications: [],
      names,
    });
    const [first] = buildTimeline({
      audit: [audit({ action: "fixture.response_recorded", createdAt: at(0), actorPlayerId: "p-1", before: { status: "pending" }, after: { status: "in" } })],
      notifications: [],
      names,
    });

    expect(changed?.title).toBe("Answered: out");
    expect(changed?.detail).toBe("was in");
    // "was pending" on every first answer is noise on a fourteen-person squad.
    expect(first?.detail).toBeNull();
  });

  it("calls an owner's promotion what it is, and says whose place was jumped", () => {
    const [entry] = buildTimeline({
      audit: [
        audit({
          action: "fixture.response_overridden",
          createdAt: at(0),
          actorPlayerId: "p-1",
          before: { status: "waitlisted" },
          after: { playerId: "p-2", status: "in", overCapacity: true, fromWaitlist: true, waitlistRank: 3 },
        }),
      ],
      notifications: [],
      names,
    });

    expect(entry?.title).toBe("Promoted off the waitlist");
    expect(entry?.subject).toBe("Bo Chen");
    expect(entry?.detail).toBe("They were 3rd in the queue.");
  });

  it("keeps a message that never went out, at the moment it was owed", () => {
    const [entry] = buildTimeline({
      audit: [],
      notifications: [
        { notificationType: "n1", playerId: "p-1", channel: "email", status: "failed", sentAt: null, createdAt: at(7) },
      ],
      names,
    });

    // Dropping it would make a send failure invisible on the one page an
    // organiser would look for it.
    expect(entry?.at).toEqual(at(7));
    expect(entry?.detail).toBe("email — failed");
  });

  it("drops actions that are not about the run-up to this fixture", () => {
    const entries = buildTimeline({
      audit: [
        audit({ action: "fixture.result_filed", createdAt: at(0) }),
        audit({ action: "game.updated", createdAt: at(1) }),
      ],
      notifications: [],
      names,
    });

    expect(entries).toEqual([]);
  });

  it("survives a stored value that is not in the lookup table", () => {
    // Neither column carries a CHECK constraint, so the enum is a claim about
    // the schema and not a guarantee about the rows.
    const entries = buildTimeline({
      audit: [audit({ action: "fixture.opened", createdAt: at(0), after: "not an object" })],
      notifications: [
        { notificationType: "n99" as never, playerId: "nobody", channel: "email", status: "sent", sentAt: at(1), createdAt: at(1) },
      ],
      names,
    });

    expect(entries).toHaveLength(2);
    expect(entries[0]?.title).toBe("n99 sent");
    // A count, not null: a recipient nobody can name still happened, and an
    // empty subject renders as a bare separator with nothing either side.
    expect(entries[0]?.subject).toBe("1 player");
    expect(entries[1]?.detail).toBeNull();
  });
});

describe("what the page leaves out, and what it folds together", () => {
  it("drops an answer that changed nothing", () => {
    // Ten taps of "out" on an already-out row wrote ten audit rows in
    // production. Nine of them record no change, and an entry saying nothing
    // happened is not history. The guard is here as well as at the write, so
    // the rows already stored stop being presented as ten events.
    const entries = buildTimeline({
      audit: [
        audit({ action: "fixture.response_recorded", createdAt: at(1), actorPlayerId: "p-1", before: { status: "out" }, after: { status: "out" } }),
        audit({ action: "fixture.response_recorded", createdAt: at(0), actorPlayerId: "p-1", before: { status: "in" }, after: { status: "out" } }),
      ],
      notifications: [],
      names,
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.detail).toBe("was in");
  });

  it("keeps a first answer, which changes pending into a real one", () => {
    const entries = buildTimeline({
      audit: [audit({ action: "fixture.response_recorded", createdAt: at(0), actorPlayerId: "p-1", before: { status: "pending" }, after: { status: "in" } })],
      notifications: [],
      names,
    });

    expect(entries).toHaveLength(1);
  });

  it("folds one send to many people into one line", () => {
    const many = ["p-1", "p-2", "p-3", "p-4"].map((playerId) => ({
      notificationType: "n1" as const,
      playerId,
      channel: "email" as const,
      status: "sent",
      sentAt: at(0),
      createdAt: at(0),
    }));

    const entries = buildTimeline({ audit: [], notifications: many, names });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.title).toBe("Invitation sent");
    expect(entries[0]?.subject).toBe("4 players");
  });

  it("still names the recipients while there are few enough to be useful", () => {
    const two = ["p-1", "p-2"].map((playerId) => ({
      notificationType: "n1" as const,
      playerId,
      channel: "email" as const,
      status: "sent",
      sentAt: at(0),
      createdAt: at(0),
    }));

    const [entry] = buildTimeline({ audit: [], notifications: two, names });

    expect(entry?.subject).toBe("Ada Okafor and Bo Chen");
  });

  it("does not fold two different messages, channels or outcomes together", () => {
    const entries = buildTimeline({
      audit: [],
      notifications: [
        { notificationType: "n1", playerId: "p-1", channel: "email", status: "sent", sentAt: at(0), createdAt: at(0) },
        { notificationType: "n1", playerId: "p-2", channel: "push", status: "sent", sentAt: at(0), createdAt: at(0) },
        { notificationType: "n2", playerId: "p-1", channel: "email", status: "sent", sentAt: at(0), createdAt: at(0) },
        { notificationType: "n1", playerId: "p-2", channel: "email", status: "failed", sentAt: null, createdAt: at(0) },
      ],
      names,
    });

    // A failure folded in with the successes is the one case where grouping
    // would hide the thing an organiser came to the page to find.
    expect(entries).toHaveLength(4);
  });

  it("does not fold sends that happened at different times", () => {
    const entries = buildTimeline({
      audit: [],
      notifications: [
        { notificationType: "n1", playerId: "p-1", channel: "email", status: "sent", sentAt: at(0), createdAt: at(0) },
        { notificationType: "n1", playerId: "p-2", channel: "email", status: "sent", sentAt: at(9), createdAt: at(9) },
      ],
      names,
    });

    expect(entries).toHaveLength(2);
  });

  it("reads every message name as a thing that was sent", () => {
    const entries = buildTimeline({
      audit: [],
      notifications: (["n2", "n3", "n9"] as const).map((notificationType, index) => ({
        notificationType,
        playerId: "p-1",
        channel: "email" as const,
        status: "sent",
        sentAt: at(index),
        createdAt: at(index),
      })),
      names,
    });

    // "Told they are in sent" was the shape before: the label has to be a
    // noun for the sentence to survive the word after it.
    expect(entries.map((entry) => entry.title)).toEqual([
      "Teams announcement sent",
      "Cancellation notice sent",
      "Promotion notice sent",
    ]);
  });
});
