import { describe, expect, it } from "vitest";
import {
  planReleases,
  whenGroupIsAsked,
  type ReleaseInput,
  type TierState,
} from "../../src/domain/invite-tiers.js";
import type { ResponseStatus } from "../../src/domain/response-status.js";

const TZ = "Europe/London";
// Wednesday Night Football's shape: opens Tue 09:00 BST, kicks off Wed 21:00 BST.
const OPENED = new Date("2026-09-29T08:00:00Z");
const KICKOFF = new Date("2026-09-30T20:00:00Z");
const bst = (day: 29 | 30, hour: number, minute = 0): Date =>
  new Date(Date.UTC(2026, 8, day, hour - 1, minute));

/**
 * A tier of members, written compactly: each string is a response status, `-`
 * for a member holding no live row, a leading `*` for one already invited by
 * a tier release, and a leading `~` for one the owner invited on their own
 * (M46) — invited either way, but only `*` releases the tier they sit in.
 *
 * `askAfterHours` is how many waking hours after the previous group this one
 * is asked, or null for "only when the groups above cannot fill the game".
 * `stampedAt` is when a `*` member was stamped.
 */
function tier(
  id: string | null,
  askAfterHours: number | null,
  members: string[],
  stampedAt: Date = OPENED,
): TierState {
  return {
    tierId: id,
    askAfterHours,
    members: members.map((member, index) => {
      const individually = member.startsWith("~");
      const invited = individually || member.startsWith("*");
      const raw = invited ? member.slice(1) : member;
      return {
        playerId: `${id ?? "implicit"}-${index}`,
        status: raw === "-" ? null : (raw as ResponseStatus),
        invitedAt: invited ? stampedAt : null,
        invitedIndividually: individually,
      };
    }),
  };
}

const n = (count: number, status: string): string[] => Array.from({ length: count }, () => status);

function input(tiers: TierState[], over: Partial<ReleaseInput> = {}): ReleaseInput {
  return {
    tiers,
    guestInCount: 0,
    maxPlayers: 16,
    now: bst(29, 9),
    timeZone: TZ,
    openedAt: OPENED,
    kicksOffAt: KICKOFF,
    force: false,
    ...over,
  };
}

describe("planReleases — the first group", () => {
  it("asks the first group when the game opens, and nobody else", () => {
    const plan = planReleases(
      input([tier("regulars", null, n(16, "pending")), tier("standby", 12, n(3, "pending"))]),
    );

    expect(plan.releasedTierIds).toEqual(["regulars"]);
    expect(plan.toInvite).toHaveLength(16);
  });

  it("asks the first group even when the game opens at night", () => {
    // The owner chose the opening time; waking hours govern only the groups
    // that follow on their own.
    const plan = planReleases(
      input([tier("regulars", null, n(16, "pending")), tier(null, 12, ["pending"])], { now: bst(30, 2) }),
    );

    expect(plan.releasedTierIds).toEqual(["regulars"]);
  });

  it("treats a gated Game with no groups defined as everyone at once", () => {
    const plan = planReleases(input([tier(null, 12, n(3, "pending"))]));

    expect(plan.toInvite).toEqual(["implicit-0", "implicit-1", "implicit-2"]);
  });
});

describe("planReleases — auto-advance: the groups asked so far cannot fill the game", () => {
  it("asks the next group at once when in + not answered falls below the maximum", () => {
    // 29 September 2026: Mark's mute declined for him at open, leaving 14 of
    // 15 regulars able to play against 16 places.
    const plan = planReleases(
      input([
        tier("regulars", null, [...n(14, "*pending"), "*out"]),
        tier("standby", 12, n(3, "pending")),
        tier(null, 12, n(8, "pending")),
      ]),
    );

    expect(plan.releasedTierIds).toEqual(["regulars", "standby"]);
    expect(plan.toInvite).toEqual(["standby-0", "standby-1", "standby-2"]);
  });

  it("holds while in + not answered exactly reaches the maximum", () => {
    // The evening of 29 September: 16 of 16 are in or have not answered.
    const plan = planReleases(
      input(
        [
          tier("regulars", null, [...n(9, "*in"), ...n(3, "*out"), ...n(3, "*pending")]),
          tier("standby", 12, ["*in", "*pending", "*pending"]),
          tier(null, 12, ["~in", "waitlisted", ...n(6, "pending")]),
        ],
        { now: bst(29, 20) },
      ),
    );

    expect(plan.toInvite).toEqual([]);
  });

  it("counts a guest as holding a place", () => {
    const plan = planReleases(
      input([tier("regulars", null, n(15, "*pending")), tier(null, 12, ["pending"])], { guestInCount: 1 }),
    );

    expect(plan.toInvite).toEqual([]);
  });

  it("counts somebody waiting for a place in a full game", () => {
    const plan = planReleases(
      input([tier("regulars", null, [...n(15, "*in"), "*waitlisted"]), tier(null, 12, ["pending"])]),
    );

    expect(plan.toInvite).toEqual([]);
  });

  it("does not count an early yes from a group not yet asked", () => {
    // Counting them would let their own keenness keep their group waiting.
    // They are named in `toInvite` with the rest; the capacity object promotes
    // them and leaves them out of the mail.
    const plan = planReleases(
      input([tier("regulars", null, n(15, "*in")), tier(null, 12, ["waitlisted", "pending"])]),
    );

    expect(plan.toInvite).toEqual(["implicit-0", "implicit-1"]);
  });

  it("treats a member with no live row as unable to play", () => {
    const plan = planReleases(
      input([tier("regulars", null, [...n(15, "*pending"), "-"]), tier(null, 12, ["pending"])]),
    );

    expect(plan.toInvite).toEqual(["implicit-0"]);
  });

  it("waits for 06:00 rather than asking at night", () => {
    const tiers = [tier("regulars", null, [...n(14, "*pending"), "*out", "*out"]), tier(null, 12, ["pending"])];

    expect(planReleases(input(tiers, { now: bst(30, 2) })).toInvite).toEqual([]);
    expect(planReleases(input(tiers, { now: bst(30, 6) })).toInvite).toEqual(["implicit-0"]);
  });

  it("cascades through several groups in one pass when none can fill the game", () => {
    const plan = planReleases(
      input([
        tier("regulars", null, n(4, "*pending")),
        tier("standby", 12, n(3, "pending")),
        tier(null, 12, ["pending"]),
      ]),
    );

    expect(plan.releasedTierIds).toEqual(["regulars", "standby", null]);
  });
});

describe("planReleases — the head start", () => {
  const full = (): TierState[] => [
    tier("regulars", null, n(16, "*pending")),
    tier("standby", 12, n(3, "pending")),
    tier(null, 6, n(8, "pending")),
  ];

  it("holds the next group until its head start has run out", () => {
    expect(planReleases(input(full(), { now: bst(29, 20) })).toInvite).toEqual([]);
  });

  it("asks the next group once the previous one has had its waking hours", () => {
    const plan = planReleases(input(full(), { now: bst(29, 21) }));

    expect(plan.releasedTierIds).toEqual(["regulars", "standby"]);
  });

  it("counts from when the previous group was actually asked, so an early ask ripples on", () => {
    // Standby was asked at 11:00 by auto-advance; Everyone else's 6 waking
    // hours then run from 11:00, not from Standby's scheduled 21:00.
    const tiers = [
      tier("regulars", null, n(16, "*pending")),
      tier("standby", 12, n(3, "*pending"), bst(29, 11)),
      tier(null, 6, n(8, "pending")),
    ];

    expect(planReleases(input(tiers, { now: bst(29, 16) })).toInvite).toEqual([]);
    expect(planReleases(input(tiers, { now: bst(29, 17) })).toInvite).toHaveLength(8);
  });

  it("pauses overnight: asked 21:00 with a 6-hour head start, the next group is due 10:00", () => {
    const tiers = [
      tier("regulars", null, n(16, "*pending")),
      tier("standby", 12, n(3, "*pending"), bst(29, 21)),
      tier(null, 6, n(8, "pending")),
    ];

    expect(planReleases(input(tiers, { now: bst(30, 9) })).toInvite).toEqual([]);
    expect(planReleases(input(tiers, { now: bst(30, 10) })).toInvite).toHaveLength(8);
  });

  it("does not ask a due group while the game is full", () => {
    const tiers = [tier("regulars", null, n(16, "*in")), tier(null, 12, ["pending"])];

    expect(planReleases(input(tiers, { now: bst(30, 12) })).toInvite).toEqual([]);
  });

  it("asks a due group even though silence still fills the count", () => {
    // In + not answered reaches 16, so auto-advance holds — silence is exactly
    // what the head start exists to stop waiting on.
    const tiers = [tier("regulars", null, [...n(8, "*in"), ...n(8, "*pending")]), tier(null, 12, ["pending"])];

    expect(planReleases(input(tiers, { now: bst(29, 20) })).toInvite).toEqual([]);
    expect(planReleases(input(tiers, { now: bst(29, 21) })).toInvite).toEqual(["implicit-0"]);
  });
});

describe("planReleases — the three-hour cut-off", () => {
  it("asks a timed group no later than three hours before kickoff", () => {
    const tiers = [
      tier("regulars", null, [...n(8, "*in"), ...n(8, "*pending")]),
      tier("standby", 40, n(3, "pending")),
    ];

    expect(planReleases(input(tiers, { now: bst(30, 17) })).toInvite).toEqual([]);
    expect(planReleases(input(tiers, { now: bst(30, 18) })).toInvite).toHaveLength(3);
  });

  it("does not ask at the cut-off when the game is already full", () => {
    const tiers = [tier("regulars", null, n(16, "*in")), tier("standby", 40, n(3, "pending"))];

    expect(planReleases(input(tiers, { now: bst(30, 18) })).toInvite).toEqual([]);
  });
});

describe("planReleases — a final group asked only when needed", () => {
  const tiers = (regulars: string[]): TierState[] => [
    tier("regulars", null, regulars),
    tier(null, null, n(8, "pending")),
  ];

  it("is never asked by the clock or the cut-off", () => {
    const plan = planReleases(input(tiers([...n(8, "*in"), ...n(8, "*pending")]), { now: bst(30, 19) }));

    expect(plan.toInvite).toEqual([]);
  });

  it("is asked by auto-advance", () => {
    const plan = planReleases(input(tiers([...n(8, "*in"), ...n(7, "*pending"), "*out"])));

    expect(plan.toInvite).toHaveLength(8);
  });
});

describe("planReleases — the owner's manual release", () => {
  it("asks exactly one more group, whatever the clock and the count say", () => {
    const plan = planReleases(
      input(
        [tier("regulars", null, n(16, "*in")), tier("standby", 12, ["pending"]), tier(null, null, ["pending"])],
        { force: true, now: bst(30, 2) },
      ),
    );

    expect(plan.releasedTierIds).toEqual(["regulars", "standby"]);
  });
});

describe("planReleases — hand invites, withdrawals and empty groups", () => {
  it("does not read a hand invite as its group being asked (M46)", () => {
    const plan = planReleases(
      input([
        tier("regulars", null, n(16, "*in")),
        tier("standby", 12, ["~in", "pending"]),
        tier(null, 12, ["pending"]),
      ]),
    );

    expect(plan.releasedTierIds).toEqual(["regulars"]);
    expect(plan.toInvite).toEqual([]);
  });

  it("does not re-stamp the player the owner already invited", () => {
    const plan = planReleases(
      input([tier("regulars", null, n(4, "*pending")), tier(null, 12, ["~pending", "pending"])]),
    );

    expect(plan.toInvite).toEqual(["implicit-1"]);
  });

  it("never invites a withdrawn player back", () => {
    const plan = planReleases(
      input([tier("regulars", null, ["*pending"]), tier(null, 12, ["withdrawn", "pending"])]),
    );

    expect(plan.toInvite).toEqual(["implicit-1"]);
  });

  it("skips a group with nobody in it, without spending a head start on it", () => {
    const tiers = [
      tier("regulars", null, n(16, "*pending")),
      tier("empty", 12, []),
      tier(null, 12, ["pending"]),
    ];

    expect(planReleases(input(tiers, { now: bst(29, 20) })).toInvite).toEqual([]);
    expect(planReleases(input(tiers, { now: bst(29, 21) })).toInvite).toEqual(["implicit-0"]);
  });

  it("returns nothing for a Game with no members at all", () => {
    expect(planReleases(input([tier(null, 12, [])])).toInvite).toEqual([]);
  });

  it("is a no-op on a second run over the same state", () => {
    const state = input([
      tier("regulars", null, [...n(14, "*pending"), "*out"]),
      tier("standby", 12, ["*pending"]),
      tier(null, 12, ["pending"]),
    ]);

    expect(planReleases(state)).toEqual(planReleases(state));
  });
});

describe("whenGroupIsAsked — what a waiting player is told", () => {
  const tiers = (): TierState[] => [
    tier("regulars", null, n(16, "*pending")),
    tier("standby", 12, ["pending"]),
    tier(null, 6, ["waitlisted"]),
  ];

  it("chains the head starts from the last group asked", () => {
    // Standby 21:00 Tue; Everyone else 6 waking hours later, 10:00 Wed.
    expect(whenGroupIsAsked(input(tiers()), "standby-0")).toEqual({ kind: "at", at: bst(29, 21) });
    expect(whenGroupIsAsked(input(tiers()), "implicit-0")).toEqual({ kind: "at", at: bst(30, 10) });
  });

  it("never promises a time after the cut-off", () => {
    const late = [tier("regulars", null, n(16, "*pending")), tier(null, 60, ["waitlisted"])];

    expect(whenGroupIsAsked(input(late), "implicit-0")).toEqual({ kind: "at", at: bst(30, 18) });
  });

  it("says a when-needed group has no time", () => {
    const needed = [tier("regulars", null, n(16, "*pending")), tier(null, null, ["waitlisted"])];

    expect(whenGroupIsAsked(input(needed), "implicit-0")).toEqual({ kind: "when-needed" });
  });

  it("reports a group already asked, and nothing for a stranger", () => {
    expect(whenGroupIsAsked(input(tiers()), "regulars-0")).toEqual({ kind: "asked" });
    expect(whenGroupIsAsked(input(tiers()), "nobody")).toBeNull();
  });
});
