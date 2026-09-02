import { describe, expect, it } from "vitest";
import { totalRecord, unrecordedIn } from "../../src/domain/record.js";

describe("unrecordedIn", () => {
  it("is the played fixtures the three outcomes do not account for", () => {
    expect(unrecordedIn({ played: 12, won: 5, lost: 3, drawn: 1 })).toBe(3);
  });

  it("is zero when every played fixture settled", () => {
    expect(unrecordedIn({ played: 9, won: 5, lost: 3, drawn: 1 })).toBe(0);
  });
});

describe("totalRecord", () => {
  it("sums every game's record", () => {
    expect(
      totalRecord([
        { played: 12, won: 5, lost: 3, drawn: 1 },
        { played: 4, won: 1, lost: 2, drawn: 1 },
      ]),
    ).toEqual({ played: 16, won: 6, lost: 5, drawn: 2 });
  });

  it("is all zeroes for a player with no games", () => {
    expect(totalRecord([])).toEqual({ played: 0, won: 0, lost: 0, drawn: 0 });
  });
});
