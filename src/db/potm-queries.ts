import { and, eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { resultElectorate } from "./result-queries.js";
import { fixturePotmVotes, players, responses } from "./schema.js";
import { displayName } from "../domain/display-name.js";
import { potmOpen, potmWinners, type PotmOutcome, type PotmVote } from "../domain/potm.js";
import { resultDeadline, type LockableFixture } from "../domain/result-lock.js";
import type { Lifecycle } from "../domain/lifecycle.js";

export interface PotmCandidate {
  playerId: string;
  /** Already through `displayName`, with a guest marked as one. */
  name: string;
}

/**
 * Who can be voted player of the match: everyone who was `in`, guests
 * included — they played, and only their notification is out of reach.
 *
 * An erased player is left out of the ballot. Their place in the fixture is
 * kept (BR-34), but "a former player" is not somebody anyone can pick.
 */
export async function potmCandidates(db: Db, fixtureId: string): Promise<PotmCandidate[]> {
  const rows = await db
    .select({ playerId: players.id, name: players.name, erasedAt: players.erasedAt, isGuest: players.isGuest })
    .from(responses)
    .innerJoin(players, eq(responses.playerId, players.id))
    .where(and(eq(responses.fixtureId, fixtureId), eq(responses.status, "in")))
    .orderBy(players.name);
  return rows
    .filter((row) => row.erasedAt === null)
    .map((row) => ({
      playerId: row.playerId,
      name: `${displayName(row.name, row.erasedAt)}${row.isGuest ? " (guest)" : ""}`,
    }));
}

export async function listPotmVotes(db: Db, fixtureId: string): Promise<PotmVote[]> {
  return db
    .select({ voterId: fixturePotmVotes.voterId, candidateId: fixturePotmVotes.candidateId })
    .from(fixturePotmVotes)
    .where(eq(fixturePotmVotes.fixtureId, fixtureId));
}

/** Cast or change a vote — one row per (fixture, voter), updated in place. */
export async function putPotmVote(
  db: Db,
  params: { fixtureId: string; voterId: string; candidateId: string; now: Date },
): Promise<void> {
  await db
    .insert(fixturePotmVotes)
    .values({
      id: crypto.randomUUID(),
      fixtureId: params.fixtureId,
      voterId: params.voterId,
      candidateId: params.candidateId,
      votedAt: params.now,
    })
    .onConflictDoUpdate({
      target: [fixturePotmVotes.fixtureId, fixturePotmVotes.voterId],
      set: { candidateId: params.candidateId, votedAt: params.now },
    });
}

/**
 * Whether this game runs the vote at all.
 *
 * Not when the organiser has hidden the squad from players (BR-33): a ballot
 * lists everyone who played, which is the squad list by another name — the
 * same reasoning `standingsForViewer` gives for the league table.
 */
export function potmEnabled(game: { squadVisibleToPlayers: boolean }): boolean {
  return game.squadVisibleToPlayers;
}

export interface PotmState {
  open: boolean;
  deadline: Date;
  candidates: PotmCandidate[];
  voterIds: Set<string>;
  votes: PotmVote[];
  /** Null while open, so no page can leak a running count. */
  outcome: PotmOutcome | null;
}

/** Everything a page or the sweep needs about one fixture's vote. */
export async function loadPotmState(
  db: Db,
  game: { id: string; resultLockHoursAfter: number },
  fixture: LockableFixture & { id: string; lifecycle: Lifecycle },
  now: Date,
): Promise<PotmState> {
  const [candidates, electorate, votes] = await Promise.all([
    potmCandidates(db, fixture.id),
    resultElectorate(db, game.id, fixture.id),
    listPotmVotes(db, fixture.id),
  ]);
  const open = potmOpen(fixture.lifecycle, fixture, game.resultLockHoursAfter, now);
  return {
    open,
    deadline: resultDeadline(fixture, game.resultLockHoursAfter),
    candidates,
    voterIds: electorate.eligibleIds,
    votes,
    outcome: open
      ? null
      : potmWinners(votes, new Set(candidates.map((candidate) => candidate.playerId)), electorate.eligibleIds),
  };
}
