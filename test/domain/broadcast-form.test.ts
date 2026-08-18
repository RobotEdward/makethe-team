import { describe, expect, it } from "vitest";
import {
  MAX_MESSAGE_LENGTH,
  MAX_SUBJECT_LENGTH,
  parseBroadcastForm,
} from "../../src/domain/broadcast-form.js";
import { DEFAULT_FIXTURE_AUDIENCE } from "../../src/domain/broadcast-audience.js";

function fieldErrors(result: { ok: false; errors: { field: string }[] }): string[] {
  return result.errors.map((e) => e.field);
}

describe("parseBroadcastForm", () => {
  it("parses a complete fixture submission, with audience as submitted", () => {
    const result = parseBroadcastForm(
      { subject: "Reminder", message: "Bring boots", email: "on", push: "on", audience: "waitlisted" },
      "fixture",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.values).toEqual({
      subject: "Reminder",
      message: "Bring boots",
      email: true,
      push: true,
      audience: "waitlisted",
    });
  });

  it("fails on subject when missing, at 61 chars, and passes at 60", () => {
    const missing = parseBroadcastForm({ message: "m", email: "on" }, "game");
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error("expected fail");
    expect(fieldErrors(missing)).toContain("subject");

    const tooLong = parseBroadcastForm(
      { subject: "a".repeat(MAX_SUBJECT_LENGTH + 1), message: "m", email: "on" },
      "game",
    );
    expect(tooLong.ok).toBe(false);
    if (tooLong.ok) throw new Error("expected fail");
    expect(fieldErrors(tooLong)).toContain("subject");

    const exact = parseBroadcastForm(
      { subject: "a".repeat(MAX_SUBJECT_LENGTH), message: "m", email: "on" },
      "game",
    );
    expect(exact.ok).toBe(true);
  });

  it("fails on message when missing, at 501 chars, and passes at 500", () => {
    const missing = parseBroadcastForm({ subject: "s", email: "on" }, "game");
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error("expected fail");
    expect(fieldErrors(missing)).toContain("message");

    const tooLong = parseBroadcastForm(
      { subject: "s", message: "a".repeat(MAX_MESSAGE_LENGTH + 1), email: "on" },
      "game",
    );
    expect(tooLong.ok).toBe(false);
    if (tooLong.ok) throw new Error("expected fail");
    expect(fieldErrors(tooLong)).toContain("message");

    const exact = parseBroadcastForm(
      { subject: "s", message: "a".repeat(MAX_MESSAGE_LENGTH), email: "on" },
      "game",
    );
    expect(exact.ok).toBe(true);
  });

  it("fails a whitespace-only subject or message", () => {
    const badSubject = parseBroadcastForm({ subject: "   ", message: "m", email: "on" }, "game");
    expect(badSubject.ok).toBe(false);
    if (badSubject.ok) throw new Error("expected fail");
    expect(fieldErrors(badSubject)).toContain("subject");

    const badMessage = parseBroadcastForm({ subject: "s", message: "   ", email: "on" }, "game");
    expect(badMessage.ok).toBe(false);
    if (badMessage.ok) throw new Error("expected fail");
    expect(fieldErrors(badMessage)).toContain("message");
  });

  it("refuses a submission with neither channel checked — the case that must never pass", () => {
    // No `email` or `push` key at all: exactly what a browser sends for two
    // unchecked checkboxes. This must not be confused with `email: "false"`,
    // which is a truthy string and would (wrongly) parse to `true`.
    const result = parseBroadcastForm({ subject: "s", message: "m" }, "game");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fail");
    expect(fieldErrors(result)).toContain("channels");
    expect(result.values.email).toBe(false);
    expect(result.values.push).toBe(false);
  });

  it("passes with one checkbox present, the other false", () => {
    const emailOnly = parseBroadcastForm({ subject: "s", message: "m", email: "on" }, "game");
    expect(emailOnly.ok).toBe(true);
    if (!emailOnly.ok) throw new Error("expected ok");
    expect(emailOnly.values.email).toBe(true);
    expect(emailOnly.values.push).toBe(false);

    const pushOnly = parseBroadcastForm({ subject: "s", message: "m", push: "on" }, "game");
    expect(pushOnly.ok).toBe(true);
    if (!pushOnly.ok) throw new Error("expected ok");
    expect(pushOnly.values.email).toBe(false);
    expect(pushOnly.values.push).toBe(true);
  });

  it("fails on audience when the fixture scope names an unrecognised one, rather than defaulting", () => {
    const result = parseBroadcastForm(
      { subject: "s", message: "m", email: "on", audience: "bogus" },
      "fixture",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fail");
    expect(fieldErrors(result)).toContain("audience");
  });

  it("refuses `everyone` on the fixture scope, substituting the default so the radios still re-render", () => {
    // `everyone` is a real audience, but not one a fixture can mean: it
    // resolves from `memberships`, and `sendBroadcast` nulls the fixture out
    // for it, so accepting it here would turn a submission from a page of
    // four response radios into a game-wide send.
    const result = parseBroadcastForm(
      { subject: "s", message: "m", email: "on", audience: "everyone" },
      "fixture",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fail");
    expect(fieldErrors(result)).toContain("audience");
    expect(result.values.audience).toBe(DEFAULT_FIXTURE_AUDIENCE);
  });

  it("defaults an absent audience on the fixture scope to DEFAULT_FIXTURE_AUDIENCE", () => {
    const result = parseBroadcastForm({ subject: "s", message: "m", email: "on" }, "fixture");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.values.audience).toBe(DEFAULT_FIXTURE_AUDIENCE);
  });

  it("forces audience to everyone on the game scope, even when the body names playing", () => {
    const result = parseBroadcastForm(
      { subject: "s", message: "m", email: "on", audience: "playing" },
      "game",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.values.audience).toBe("everyone");
  });

  it("returns the typed subject and message in values on a failing parse", () => {
    const result = parseBroadcastForm({ subject: "Hello there", message: "Some words" }, "game");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fail");
    expect(result.values.subject).toBe("Hello there");
    expect(result.values.message).toBe("Some words");
  });
});
