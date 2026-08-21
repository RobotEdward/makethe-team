import { describe, expect, it } from "vitest";
import {
  broadcastMessage,
  cancelledMessage,
  openMessage,
  teamsMessage,
  whatsappShareUrl,
  type OpenMessageFacts,
} from "../../src/domain/whatsapp-message.js";

const facts = (over: Partial<OpenMessageFacts> = {}): OpenMessageFacts => ({
  gameName: "Thursday Fives",
  venueName: "Powerleague Shoreditch",
  kicksOffAtLocal: "Thu 27 Aug, 19:00",
  inCount: 7,
  minPlayers: 10,
  maxPlayers: 14,
  gameUrl: "https://makethe.team/g/abc",
  ...over,
});

describe("openMessage", () => {
  it("names the game, kickoff and venue, and ends with the game link", () => {
    const text = openMessage(facts());
    expect(text.startsWith("⚽ Thursday Fives — Thu 27 Aug, 19:00 at Powerleague Shoreditch")).toBe(true);
    expect(text.endsWith("In or out? Say so on Make The Team: https://makethe.team/g/abc")).toBe(true);
  });

  it("asks for more when under the minimum", () => {
    expect(openMessage(facts({ inCount: 7 }))).toContain("7 in so far — 3 more needed.");
    expect(openMessage(facts({ inCount: 9 }))).toContain("9 in so far — 1 more needed.");
  });

  it("says how many spots are left once the minimum is met", () => {
    expect(openMessage(facts({ inCount: 10 }))).toContain("10 in, 4 spots left.");
    expect(openMessage(facts({ inCount: 13 }))).toContain("13 in, 1 spot left.");
  });

  it("says full, with the waitlist, at or over capacity", () => {
    expect(openMessage(facts({ inCount: 14 }))).toContain("14 in — full, but you can join the waitlist.");
    expect(openMessage(facts({ inCount: 16 }))).toContain("16 in — full, but you can join the waitlist.");
  });

  it("never prints a negative number when nobody has answered", () => {
    expect(openMessage(facts({ inCount: 0 }))).toContain("0 in so far — 10 more needed.");
  });
});

describe("teamsMessage", () => {
  it("lists each side on its own line", () => {
    const text = teamsMessage({
      gameName: "Thursday Fives",
      kicksOffAtLocal: "Thu 27 Aug, 19:00",
      lineUps: [
        { name: "Bibs", players: ["Ade", "Ben"] },
        { name: "Colours", players: ["Cal"] },
      ],
    });
    expect(text).toBe("⚽ Thursday Fives — Thu 27 Aug, 19:00\nTeams:\nBibs: Ade, Ben\nColours: Cal");
  });

  it("says when a side has nobody on it yet", () => {
    const text = teamsMessage({
      gameName: "Thursday Fives",
      kicksOffAtLocal: "Thu 27 Aug, 19:00",
      lineUps: [
        { name: "Bibs", players: ["Ade"] },
        { name: "Colours", players: [] },
      ],
    });
    expect(text).toContain("Colours: nobody yet");
  });
});

describe("cancelledMessage", () => {
  it("says the fixture is off", () => {
    expect(cancelledMessage({ gameName: "Thursday Fives", kicksOffAtLocal: "Thu 27 Aug, 19:00", reason: null })).toBe(
      "Thursday Fives on Thu 27 Aug, 19:00 is cancelled.",
    );
  });

  it("carries the organiser's reason when there is one, and drops a blank one", () => {
    const withReason = cancelledMessage({
      gameName: "Thursday Fives",
      kicksOffAtLocal: "Thu 27 Aug, 19:00",
      reason: "  Pitch is flooded.  ",
    });
    expect(withReason).toBe("Thursday Fives on Thu 27 Aug, 19:00 is cancelled.\nPitch is flooded.");
    expect(cancelledMessage({ gameName: "X", kicksOffAtLocal: "Y", reason: "   " })).toBe("X on Y is cancelled.");
  });
});

describe("broadcastMessage", () => {
  it("is the subject, a blank line, then the message", () => {
    expect(broadcastMessage({ subject: "Shin pads", message: "Bring them." })).toBe("Shin pads\n\nBring them.");
  });

  it("is just the message when the subject is blank", () => {
    expect(broadcastMessage({ subject: "  ", message: "Bring them." })).toBe("Bring them.");
  });
});

describe("whatsappShareUrl", () => {
  it("is a wa.me link with the text URL-encoded, so & # newlines and emoji survive", () => {
    const url = whatsappShareUrl("A & B #1\n⚽ go");
    expect(url.startsWith("https://wa.me/?text=")).toBe(true);
    const encoded = url.slice("https://wa.me/?text=".length);
    expect(encoded).not.toContain("&");
    expect(encoded).not.toContain("#");
    expect(encoded).not.toContain("\n");
    expect(decodeURIComponent(encoded)).toBe("A & B #1\n⚽ go");
  });
});
