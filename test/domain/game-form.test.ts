import { describe, expect, it } from "vitest";
import {
  localDateToday,
  parseGameForm,
  parseNotificationCells,
  RESULT_LOCK_CHOICES,
  supportedTimezones,
} from "../../src/domain/game-form.js";

/** The minimum a valid submission carries. Individual tests override one key. */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Thursday 7-a-side",
    venueName: "Oxford Sports Park",
    venueAddress: "Marston Ferry Road",
    weekday: "TH",
    interval: "1",
    kickoffTime: "19:00",
    durationMinutes: "60",
    minPlayers: "10",
    maxPlayers: "14",
    prefersEvenNumbers: "on",
    ...overrides,
  };
}

function errorsFor(overrides: Record<string, unknown>): string[] {
  const result = parseGameForm(body(overrides));
  if (result.ok) throw new Error("expected the form to be rejected");
  return result.errors.map((error) => error.field);
}

describe("parseGameForm", () => {
  it("accepts a complete submission and builds the recurrence rule", () => {
    const result = parseGameForm(body());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.values.recurrenceRule).toBe("FREQ=WEEKLY;INTERVAL=1;BYDAY=TH");
    expect(result.values.kickoffTime).toBe("19:00");
    expect(result.values.minPlayers).toBe(10);
    expect(result.values.prefersEvenNumbers).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("defaults every field the create form does not ask for", () => {
    const result = parseGameForm(body());
    if (!result.ok) throw new Error("expected ok");

    expect(result.values.timezone).toBe("Europe/London");
    expect(result.values.reminderDaysBefore).toBe(1);
    expect(result.values.reminderLocalTime).toBe("09:00");
    expect(result.values.shortWarningOffsetHours).toBe(12);
    expect(result.values.venueUrl).toBeNull();
  });

  it("treats an absent checkbox as false", () => {
    // An unchecked HTML checkbox is absent from the body entirely, not "off".
    const result = parseGameForm(body({ prefersEvenNumbers: undefined }));
    if (!result.ok) throw new Error("expected ok");
    expect(result.values.prefersEvenNumbers).toBe(false);
  });

  it("reads the squad-visibility checkbox when ticked", () => {
    const result = parseGameForm(body({ squadVisibleToPlayers: "on" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.squadVisibleToPlayers).toBe(true);
  });

  it("treats an absent squad-visibility checkbox as off", () => {
    // An unchecked checkbox is simply absent from the POST body. This is the
    // whole reason the view needs a hidden marker field — see the view test.
    const result = parseGameForm(body({ squadVisibleToPlayers: undefined }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.squadVisibleToPlayers).toBe(false);
  });

  it("trims the free-text fields", () => {
    const result = parseGameForm(body({ name: "  Thursday 7-a-side  " }));
    if (!result.ok) throw new Error("expected ok");
    expect(result.values.name).toBe("Thursday 7-a-side");
  });

  it("treats a blank optional field as null, not an empty string", () => {
    const result = parseGameForm(body({ venueAddress: "   " }));
    if (!result.ok) throw new Error("expected ok");
    expect(result.values.venueAddress).toBeNull();
  });

  it("rejects a missing name and a missing venue", () => {
    expect(errorsFor({ name: "" })).toContain("name");
    expect(errorsFor({ venueName: "" })).toContain("venueName");
  });

  it("rejects an over-long name rather than truncating it", () => {
    expect(errorsFor({ name: "x".repeat(201) })).toContain("name");
  });

  it("rejects min above max", () => {
    expect(errorsFor({ minPlayers: "15", maxPlayers: "14" })).toContain("minPlayers");
  });

  it("accepts min equal to max", () => {
    expect(parseGameForm(body({ minPlayers: "12", maxPlayers: "12" })).ok).toBe(true);
  });

  it("rejects a zero, negative or non-numeric player count", () => {
    expect(errorsFor({ minPlayers: "0" })).toContain("minPlayers");
    expect(errorsFor({ maxPlayers: "-1" })).toContain("maxPlayers");
    expect(errorsFor({ maxPlayers: "eleven" })).toContain("maxPlayers");
    expect(errorsFor({ maxPlayers: "11.5" })).toContain("maxPlayers");
  });

  it("rejects a duration of zero or more than a day", () => {
    expect(errorsFor({ durationMinutes: "0" })).toContain("durationMinutes");
    expect(errorsFor({ durationMinutes: "1441" })).toContain("durationMinutes");
  });

  it("rejects a kickoff time that is not HH:MM", () => {
    // Routed through parseLocalTime so an out-of-range LocalParts can never be
    // constructed from a form (docs/known-issues.md, spec §3.2).
    expect(errorsFor({ kickoffTime: "25:00" })).toContain("kickoffTime");
    expect(errorsFor({ kickoffTime: "7pm" })).toContain("kickoffTime");
    expect(errorsFor({ kickoffTime: "19:60" })).toContain("kickoffTime");
  });

  it("rejects an interval other than 1 or 2", () => {
    expect(errorsFor({ interval: "3" })).toContain("interval");
    expect(errorsFor({ interval: "0" })).toContain("interval");
  });

  it("rejects a weekday outside the seven BYDAY codes", () => {
    expect(errorsFor({ weekday: "XX" })).toContain("weekday");
  });

  it("rejects a timezone that is not a supported IANA zone", () => {
    expect(errorsFor({ timezone: "Mars/Olympus_Mons" })).toContain("timezone");
    expect(errorsFor({ timezone: "" })).toContain("timezone");
  });

  it("accepts every timezone it offers", () => {
    // The picker and the validator must agree, or the form can reject its own
    // options. Spot-check the ends and the default rather than all ~400.
    const zones = supportedTimezones();
    expect(zones).toContain("Europe/London");
    for (const timezone of [zones[0]!, zones[zones.length - 1]!, "Europe/London"]) {
      expect(parseGameForm(body({ timezone })).ok).toBe(true);
    }
  });

  it("rejects a venue URL that is not http or https", () => {
    expect(errorsFor({ venueUrl: "javascript:alert(1)" })).toContain("venueUrl");
    expect(errorsFor({ venueUrl: "not a url" })).toContain("venueUrl");
    expect(parseGameForm(body({ venueUrl: "https://example.com/pitch" })).ok).toBe(true);
  });

  it("rejects reminder and warning settings outside their ranges", () => {
    expect(errorsFor({ reminderDaysBefore: "8" })).toContain("reminderDaysBefore");
    expect(errorsFor({ reminderDaysBefore: "-1" })).toContain("reminderDaysBefore");
    expect(errorsFor({ reminderLocalTime: "24:00" })).toContain("reminderLocalTime");
    expect(errorsFor({ shortWarningOffsetHours: "0" })).toContain("shortWarningOffsetHours");
    expect(errorsFor({ shortWarningOffsetHours: "169" })).toContain("shortWarningOffsetHours");
  });

  it("rejects an explicitly blank reminder time rather than defaulting it", () => {
    // Unlike a <select>, an <input type="time"> can be cleared and submitted
    // blank on the edit form's Advanced block. That must be rejected, not
    // silently coerced to the default — the same rule already applied to
    // timezone.
    expect(errorsFor({ reminderLocalTime: "" })).toContain("reminderLocalTime");
  });

  it("reports every bad field at once, not just the first", () => {
    // The form redisplays all errors together; stopping at the first would
    // make a wrong submission take four round trips to fix.
    const fields = errorsFor({ name: "", minPlayers: "0", kickoffTime: "nope" });
    expect(fields).toEqual(expect.arrayContaining(["name", "minPlayers", "kickoffTime"]));
  });

  it("warns, but does not reject, an odd max with prefers-even (spec Part 3 item 6)", () => {
    const result = parseGameForm(body({ maxPlayers: "13", prefersEvenNumbers: "on" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("13");
  });

  it("does not warn about an odd max when parity is not preferred", () => {
    const result = parseGameForm(body({ maxPlayers: "13", prefersEvenNumbers: undefined }));
    if (!result.ok) throw new Error("expected ok");
    expect(result.warnings).toEqual([]);
  });

  it("ignores a non-string body value rather than coercing it", () => {
    // c.req.parseBody() can hand back a File for a multipart field.
    expect(errorsFor({ name: { not: "a string" } })).toContain("name");
  });

  it("defaults the team names when the form omits them", () => {
    const result = parseGameForm(body({ teamAName: "", teamBName: "" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.values.teamAName).toBe("Team A");
    expect(result.values.teamBName).toBe("Team B");
  });

  it("keeps the names an organiser chose", () => {
    const result = parseGameForm(body({ teamAName: "Bibs", teamBName: "Skins" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.values.teamAName).toBe("Bibs");
    expect(result.values.teamBName).toBe("Skins");
  });

  // Names reach an email subject line and a page heading, so an unbounded
  // string is a layout problem as well as a storage one.
  it("rejects a team name longer than 40 characters", () => {
    const result = parseGameForm(body({ teamAName: "x".repeat(41) }));
    expect(result.ok).toBe(false);
  });
});

describe("localDateToday", () => {
  it("reads the local calendar date in the game's zone", () => {
    // 2026-08-12T23:30Z is already the 13th in Auckland.
    const instant = new Date(Date.UTC(2026, 7, 12, 23, 30));
    expect(localDateToday(instant, "Europe/London")).toBe("2026-08-13");
    expect(localDateToday(instant, "Pacific/Auckland")).toBe("2026-08-13");
    expect(localDateToday(instant, "America/Los_Angeles")).toBe("2026-08-12");
  });
});

describe("parseGameForm — result-prompt offset", () => {
  it("defaults to zero when the section was not rendered", () => {
    // The create form has no notification section, so nothing about the
    // offset is submitted.
    const result = parseGameForm(body());
    if (!result.ok) throw new Error("expected ok");
    expect(result.values.resultPromptOffsetHours).toBe(0);
  });

  it("accepts a result-prompt offset inside the range", () => {
    const result = parseGameForm(body({ resultPromptOffsetHours: "12" }));
    if (!result.ok) throw new Error("expected ok");
    expect(result.values.resultPromptOffsetHours).toBe(12);
  });

  it("rejects a result-prompt offset outside the range", () => {
    expect(errorsFor({ resultPromptOffsetHours: "-1" })).toContain("resultPromptOffsetHours");
    expect(errorsFor({ resultPromptOffsetHours: "49" })).toContain("resultPromptOffsetHours");
    expect(errorsFor({ resultPromptOffsetHours: "later" })).toContain("resultPromptOffsetHours");
  });
});

describe("parseGameForm — the result window", () => {
  it("defaults to 24 hours when the section was not rendered", () => {
    // The create form has no Advanced section, so nothing about the window is
    // submitted and BR-37's default stands.
    const result = parseGameForm(body());
    if (!result.ok) throw new Error("expected ok");
    expect(result.values.resultLockHoursAfter).toBe(24);
  });

  it("accepts every length the form offers", () => {
    for (const hours of RESULT_LOCK_CHOICES) {
      const result = parseGameForm(body({ resultLockHoursAfter: String(hours) }));
      if (!result.ok) throw new Error(`expected ok for ${hours}`);
      expect(result.values.resultLockHoursAfter).toBe(hours);
    }
  });

  /**
   * Refused rather than clamped to the nearest offered length: a submission
   * this form could not have produced is a hand-crafted POST, and storing a
   * window nobody chose is worse than refusing it — the reasoning
   * `parseMuteDuration` states for the same shape of field.
   */
  it("refuses a length it does not offer, including a plausible one", () => {
    expect(errorsFor({ resultLockHoursAfter: "36" })).toContain("resultLockHoursAfter");
    expect(errorsFor({ resultLockHoursAfter: "0" })).toContain("resultLockHoursAfter");
    expect(errorsFor({ resultLockHoursAfter: "-24" })).toContain("resultLockHoursAfter");
    expect(errorsFor({ resultLockHoursAfter: "forever" })).toContain("resultLockHoursAfter");
  });
});

describe("parseNotificationCells", () => {
  it("returns only cells whose marker was posted, with their checkbox state", () => {
    const cells = parseNotificationCells({
      "notify.n9.email.seen": "1", "notify.n9.email": "on",
      "notify.n9.push.seen": "1",
      "notify.n1.email": "on", // no marker: an unrendered cell, ignored
    });
    expect(cells).toEqual([
      { type: "n9", channel: "email", enabled: true },
      { type: "n9", channel: "push", enabled: false },
    ]);
  });

  it("ignores a marker for a cell the catalogue does not have", () => {
    expect(parseNotificationCells({ "notify.n11.email.seen": "1", "notify.n2.email.seen": "1" })).toEqual([]);
  });
});

describe("parseGameForm — gated invites (M34)", () => {
  /** The edit form's gating section, as it submits when the switch is on. */
  function gatedBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return body({
      gatedInvitesEnabledSubmitted: "1",
      gatedInvitesEnabled: "on",
      gatedFallbackHoursBefore: "12",
      ...overrides,
    });
  }

  it("defaults a new game to ungated with no fallback (BR-39)", () => {
    // The create form has no gating section, so nothing about it is submitted.
    // Unlike the notification switches, absent must read as off: a Game nobody
    // has configured asks its whole squad at once.
    const result = parseGameForm(body());
    if (!result.ok) throw new Error("expected ok");

    expect(result.values.gatedInvitesEnabled).toBe(false);
    expect(result.values.gatedFallbackHoursBefore).toBeNull();
  });

  it("reads the gating switch back when the section was submitted", () => {
    const result = parseGameForm(gatedBody());
    if (!result.ok) throw new Error("expected ok");

    expect(result.values.gatedInvitesEnabled).toBe(true);
    expect(result.values.gatedFallbackHoursBefore).toBe(12);
  });

  it("treats an unticked gating box in a submitted section as off", () => {
    // The marker is the whole point: without it this body is indistinguishable
    // from the create form's, and the owner's untick would be discarded.
    const result = parseGameForm(gatedBody({ gatedInvitesEnabled: undefined }));
    if (!result.ok) throw new Error("expected ok");

    expect(result.values.gatedInvitesEnabled).toBe(false);
  });

  it("parses the fallback as null when the owner chooses never (BR-44)", () => {
    const result = parseGameForm(gatedBody({ gatedFallbackHoursBefore: "never" }));
    if (!result.ok) throw new Error("expected ok");

    expect(result.values.gatedFallbackHoursBefore).toBeNull();
  });

  it("accepts a fallback of zero hours", () => {
    const result = parseGameForm(gatedBody({ gatedFallbackHoursBefore: "0" }));
    if (!result.ok) throw new Error("expected ok");

    expect(result.values.gatedFallbackHoursBefore).toBe(0);
  });

  it("rejects a fallback that is not a whole number of hours", () => {
    expect(errorsFor({ gatedFallbackHoursBefore: "half" })).toContain("gatedFallbackHoursBefore");
    expect(errorsFor({ gatedFallbackHoursBefore: "1.5" })).toContain("gatedFallbackHoursBefore");
    expect(errorsFor({ gatedFallbackHoursBefore: "-1" })).toContain("gatedFallbackHoursBefore");
    expect(errorsFor({ gatedFallbackHoursBefore: "169" })).toContain("gatedFallbackHoursBefore");
  });
});
