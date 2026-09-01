import { describe, expect, it } from "vitest";
import { planReleases, type ReleaseInput, type TierState } from "../../src/domain/invite-tiers.js";
import type { ResponseStatus } from "../../src/domain/response-status.js";

const INVITED = new Date("2026-08-24T09:00:00Z");

/**
 * A tier of members, written compactly: each string is a response status, `-`
 * for a member holding no live row, and a leading `*` for one already invited.
 */
function tier(id: string | null, ...members: string[]): TierState {
  return {
    tierId: id,
    members: members.map((member, index) => {
      const invited = member.startsWith("*");
      const raw = invited ? member.slice(1) : member;
      return {
        playerId: `${id ?? "implicit"}-${index}`,
        status: raw === "-" ? null : (raw as ResponseStatus),
        invitedAt: invited ? INVITED : null,
      };
    }),
  };
}

function input(tiers: TierState[], over: Partial<ReleaseInput> = {}): ReleaseInput {
  return {
    tiers,
    guestInCount: 0,
    maxPlayers: 10,
    minPlayers: 8,
    fallbackDue: false,
    force: false,
    ...over,
  };
}

describe("planReleases — the worked example from the spec", () => {
  // Core of 5, Regulars of 3, Ida, then the implicit tier. max 10, min 8.
  const CORE = ["pending", "pending", "pending", "pending", "pending"];
  const REGULARS = ["pending", "pending", "pending"];

  it("keeps releasing when every member of a released tier has left the squad", () => {
    // Not the reminder instant — BR-1 writes a `pending` row for every active
    // member, so an all-absent squad means they have since been removed. Each
    // absence is a shortfall, so the order is walked to the end and nobody is
    // stranded on the bench behind a tier of ghosts.
    const plan = planReleases(
      input([
        tier("core", "-", "-", "-", "-", "-"),
        tier("regulars", "-", "-", "-"),
        tier("ida", "-"),
        tier(null, "-", "-", "-", "-", "-"),
      ]),
    );

    expect(plan.releasedCount).toBe(4);
    expect(plan.toInvite).toHaveLength(0);
  });

  it("releases the core and stamps every live row in it", () => {
    const plan = planReleases(
      input([tier("core", ...CORE), tier("regulars", ...REGULARS), tier("ida", "pending"), tier(null, "pending")]),
    );

    expect(plan.releasedCount).toBe(1);
    expect(plan.toInvite).toEqual(["core-0", "core-1", "core-2", "core-3", "core-4"]);
  });

  it("releases the second tier in the same pass when a core member is muted out (M28)", () => {
    const plan = planReleases(
      input([
        tier("core", "*pending", "*pending", "*pending", "*pending", "*out"),
        tier("regulars", ...REGULARS),
        tier("ida", "pending"),
        tier(null, "pending"),
      ]),
    );

    expect(plan.releasedCount).toBe(2);
    expect(plan.toInvite).toEqual(["regulars-0", "regulars-1", "regulars-2"]);
  });

  it("releases a third tier when a core member declines", () => {
    const plan = planReleases(
      input([
        tier("core", "*pending", "*pending", "*pending", "*out", "*out"),
        tier("regulars", "*pending", "*pending", "*pending"),
        tier("ida", "pending"),
        tier(null, "pending"),
      ]),
    );

    expect(plan.releasedCount).toBe(3);
    expect(plan.toInvite).toEqual(["ida-0"]);
  });

  it("lets a sub's decline release the tier after it", () => {
    const plan = planReleases(
      input([
        tier("core", "*pending", "*pending", "*pending", "*out", "*out"),
        tier("regulars", "*out", "*pending", "*pending"),
        tier("ida", "*pending"),
        tier(null, "pending", "pending"),
      ]),
    );

    expect(plan.releasedCount).toBe(4);
    expect(plan.toInvite).toEqual(["implicit-0", "implicit-1"]);
  });
});

describe("planReleases — the BR-43 veto", () => {
  // A core of 12 against max_players 10, which is what it takes for the
  // fixture to be full while tiers are still owed.
  const core = (outs: number) => Array.from({ length: 12 }, (_, i) => (i < outs ? "*out" : "*pending"));

  it("holds a tier back while the fixture is full", () => {
    const plan = planReleases(input([tier("core", ...core(1)), tier("subs", "pending")]));

    expect(plan.releasedCount).toBe(1);
    expect(plan.toInvite).toHaveLength(0);
  });

  it("releases the held-back tier once potential drops below max", () => {
    const plan = planReleases(input([tier("core", ...core(3)), tier("subs", "pending")]));

    expect(plan.releasedCount).toBe(2);
    expect(plan.toInvite).toEqual(["subs-0"]);
  });
});

describe("planReleases — potential counts everyone holding a slot", () => {
  const shortCore = [tier("core", "*out", "*out", "*pending"), tier("subs", "pending"), tier(null, "pending")];

  it("counts a guest, so a guest reduces how many tiers are released", () => {
    const withoutGuests = planReleases(input(shortCore, { maxPlayers: 3 }));
    const withGuests = planReleases(input(shortCore, { maxPlayers: 3, guestInCount: 2 }));

    // Two declines owe two further tiers and there is room for both; the two
    // guests fill the same room, so the veto holds everything back.
    expect(withoutGuests.releasedCount).toBe(3);
    expect(withGuests.releasedCount).toBe(1);
  });

  it("counts an early volunteer from an unreleased tier (BR-40)", () => {
    const plan = planReleases(
      input([tier("core", "*out", "*pending"), tier("subs", "in", "pending")], { maxPlayers: 2 }),
    );

    // potential = 1 pending in the core + 1 `in` volunteer = 2, which is max.
    expect(plan.releasedCount).toBe(1);
  });

  it("counts a waitlisted member, so keenness never releases a tier", () => {
    const plan = planReleases(
      input([tier("core", "*in", "*waitlisted"), tier("subs", "pending")], { maxPlayers: 2 }),
    );

    expect(plan.releasedCount).toBe(1);
  });
});

/**
 * The invariant this milestone turns on. A gate-waitlisted player — one who
 * volunteered from a tier that has not been released — is waiting *on the
 * gate*, not holding a slot. Counting them in `potential` makes their own
 * answer the thing that vetoes the release they are waiting for, and the
 * fixture then kicks off short with a willing player stuck on the bench.
 *
 * Enumerating rather than spot-checking: every status a member can hold is
 * asserted on both sides of the release line, so a future edit to `measure`
 * cannot quietly restore the deadlock for one of them.
 */
describe("planReleases — an unreleased waitlisted member never vetoes their own tier", () => {
  it("does not count a gate-waitlisted volunteer toward potential", () => {
    const plan = planReleases(
      input([tier("core", "*out", "*pending"), tier("subs", "waitlisted", "pending")], { maxPlayers: 2 }),
    );

    // The decline owes a tier. potential is the one remaining core `pending`
    // and nothing from the unreleased sub, so 1 < 2 and the subs tier opens —
    // which is what promotes the volunteer waiting on it.
    //
    // `maxPlayers` is 2 to make this discriminate: counting the volunteer, as
    // the rule did before BR-40a, puts potential at exactly 2, vetoing the
    // release they are themselves waiting for. That is the deadlock.
    expect(plan.releasedCount).toBe(2);
    expect(plan.toInvite).toEqual(["subs-0", "subs-1"]);
  });

  it("still counts a waitlisted member once their own tier is released", () => {
    const plan = planReleases(
      input([tier("core", "*in", "*pending"), tier("subs", "*waitlisted", "*pending")], { maxPlayers: 3 }),
    );

    // The same two people, now invited: they hold their places and the
    // implicit tier behind them stays shut.
    expect(plan.releasedCount).toBe(2);
  });

  it("counts an owner's override of an unreleased player, who really does hold a slot", () => {
    const plan = planReleases(
      input([tier("core", "*in", "*pending"), tier("subs", "in", "pending")], { maxPlayers: 3 }),
    );

    // BR-40a exempts the owner, so an unreleased `in` is a real occupant and
    // must veto exactly as before. Contrast the first case: same shape, and
    // only the status differs.
    expect(plan.releasedCount).toBe(1);
  });

  it("stops the cascade at the volunteer's own tier once it is open", () => {
    // The mirror of the first case. Releasing the subs tier makes the
    // volunteer count, and that is what must hold the implicit tier shut:
    // the decline is answered by the person already waiting for it, so the
    // whole squad does not get dragged in behind them.
    const plan = planReleases(
      input([tier("core", "*out", "*pending"), tier("subs", "waitlisted"), tier(null, "pending")], {
        maxPlayers: 10,
      }),
    );

    expect(plan.releasedCount).toBe(2);
    expect(plan.toInvite).toEqual(["subs-0"]);
  });

  it("does not let a gate-waitlisted volunteer hold back the BR-44 fallback", () => {
    const plan = planReleases(
      input([tier("core", "*pending", "*pending"), tier("subs", "waitlisted", "pending")], {
        maxPlayers: 10,
        minPlayers: 3,
        fallbackDue: true,
      }),
    );

    // potential = 2 released pendings, one short of the 3 the fallback needs,
    // so it must walk on. Counting the volunteer as the third body is exactly
    // what would stop it here at 1 — which is what this pins.
    expect(plan.releasedCount).toBe(2);
  });
});

describe("planReleases — shortfall counts from the membership side", () => {
  it("treats a member with no live row as missing, as withdrawMember deletes it", () => {
    const plan = planReleases(input([tier("core", "*pending", "*pending", "-"), tier("subs", "pending")]));

    expect(plan.releasedCount).toBe(2);
  });

  it("never invites a withdrawn player back", () => {
    const plan = planReleases(input([tier("core", "pending", "withdrawn")]));

    expect(plan.toInvite).toEqual(["core-0"]);
  });
});

describe("planReleases — the fallback and the manual release", () => {
  it("releases nothing extra before the fallback instant", () => {
    const plan = planReleases(
      input([tier("core", "*pending", "*pending"), tier("subs", "pending")], { minPlayers: 8 }),
    );

    expect(plan.releasedCount).toBe(1);
  });

  it("releases until minPlayers is reachable once the fallback is due (BR-44)", () => {
    const plan = planReleases(
      input(
        [
          tier("core", "*pending", "*pending"),
          tier("subs", "pending", "pending"),
          tier(null, "pending", "pending", "pending", "pending"),
        ],
        { minPlayers: 8, fallbackDue: true },
      ),
    );

    expect(plan.releasedCount).toBe(3);
  });

  it("stops at the last tier rather than looping", () => {
    const plan = planReleases(input([tier("core", "*pending")], { minPlayers: 99, fallbackDue: true }));

    expect(plan.releasedCount).toBe(1);
  });

  it("releases exactly one tier on force, ignoring the veto", () => {
    const plan = planReleases(
      input([tier("core", "*in", "*in"), tier("subs", "pending"), tier(null, "pending")], {
        maxPlayers: 2,
        force: true,
      }),
    );

    expect(plan.releasedCount).toBe(2);
    expect(plan.toInvite).toEqual(["subs-0"]);
  });
});

describe("planReleases — degenerate shapes", () => {
  it("treats a gated Game with no tiers defined as ungated (the implicit tier is tier one)", () => {
    const plan = planReleases(input([tier(null, "pending", "pending", "pending")]));

    expect(plan.releasedCount).toBe(1);
    expect(plan.toInvite).toEqual(["implicit-0", "implicit-1", "implicit-2"]);
  });

  it("is a no-op on a second run — the same state plans the same releases", () => {
    const state = input([
      tier("core", "*pending", "*out"),
      tier("subs", "*pending"),
      tier(null, "pending"),
    ]);

    const first = planReleases(state);
    const second = planReleases(state);

    expect(second).toEqual(first);
    // One decline, and the tier it owed is already released — so the implicit
    // tier stays held and there is nobody new to stamp.
    expect(first).toEqual({ releasedCount: 2, toInvite: [] });
  });

  it("skips an empty tier without stalling", () => {
    const plan = planReleases(input([tier("core", "*out"), tier("empty"), tier("subs", "pending")]));

    expect(plan.releasedCount).toBe(3);
    expect(plan.toInvite).toEqual(["subs-0"]);
  });

  it("returns nothing for a Game with no members at all", () => {
    const plan = planReleases(input([tier(null)]));

    expect(plan).toEqual({ releasedCount: 1, toInvite: [] });
  });
});
