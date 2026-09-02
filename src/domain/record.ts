/**
 * A playing record: how many were played, and how those that settled went
 * (M48).
 *
 * Its own module, importing nothing, because both the per-game rows
 * (`src/db/record-queries.ts`) and the total across them are the same four
 * numbers, and the total has to be summed from exactly the rows the page
 * shows — a second query for it could disagree with the table above it.
 */
export interface PlayerRecord {
  played: number;
  won: number;
  lost: number;
  drawn: number;
}

/**
 * The fixtures counted as played whose result is not attributable to the
 * player: nobody agreed one, the window has not locked, the sweep has not
 * cached it yet, or no sides were ever picked.
 *
 * Derived rather than counted in the query beside the other four, so it cannot
 * disagree with them: this is the arithmetic that makes a row add up, and a
 * fifth `SUM(CASE …)` could be wrong in the same direction as one of the
 * others and hide it.
 */
export function unrecordedIn(record: PlayerRecord): number {
  return record.played - record.won - record.lost - record.drawn;
}

/** The same four numbers across every game, summed from the rows on show. */
export function totalRecord(records: readonly PlayerRecord[]): PlayerRecord {
  return records.reduce<PlayerRecord>(
    (total, record) => ({
      played: total.played + record.played,
      won: total.won + record.won,
      lost: total.lost + record.lost,
      drawn: total.drawn + record.drawn,
    }),
    { played: 0, won: 0, lost: 0, drawn: 0 },
  );
}
