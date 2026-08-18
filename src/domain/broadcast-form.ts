import {
  DEFAULT_FIXTURE_AUDIENCE,
  isFixtureAudience,
  type BroadcastAudience,
} from "./broadcast-audience.js";
import { text, type FieldError } from "./game-form.js";

/**
 * Parse and validate the quick-message compose form (M15 spec §2). Pure: no
 * database, no clock, no HTTP. Shared by the game-scoped and fixture-scoped
 * compose pages so the two cannot disagree about what a valid message is.
 */

export const MAX_SUBJECT_LENGTH = 60;
export const MAX_MESSAGE_LENGTH = 500;

export interface BroadcastFormValues {
  subject: string;
  message: string;
  email: boolean;
  push: boolean;
  /** Always `"everyone"` for the game scope, whatever was submitted. */
  audience: BroadcastAudience;
}

export type BroadcastFormResult =
  | { ok: true; values: BroadcastFormValues }
  /** `values` is what was typed, so a refusal can re-render the form with it intact. */
  | { ok: false; values: BroadcastFormValues; errors: FieldError[] };

export function parseBroadcastForm(
  body: Record<string, unknown>,
  scope: "game" | "fixture",
): BroadcastFormResult {
  const errors: FieldError[] = [];
  const fail = (field: string, message: string): void => void errors.push({ field, message });

  const subject = text(body["subject"]);
  if (subject === "") fail("subject", "Give the message a subject.");
  else if (subject.length > MAX_SUBJECT_LENGTH) {
    fail("subject", `Keep the subject under ${MAX_SUBJECT_LENGTH} characters.`);
  }

  const message = text(body["message"]);
  if (message === "") fail("message", "Write a message.");
  else if (message.length > MAX_MESSAGE_LENGTH) {
    fail("message", `Keep the message under ${MAX_MESSAGE_LENGTH} characters.`);
  }

  // A browser sends no key at all for an unchecked checkbox, so "absent" is
  // the normal shape of "not ticked", matching `prefersEvenNumbers` in
  // `game-form.ts`.
  const email = typeof body["email"] === "string";
  const push = typeof body["push"] === "string";
  if (!email && !push) {
    fail("channels", "Pick at least one way to send this — email, push, or both.");
  }

  // The game scope renders no audience control at all, so anything arriving
  // in that field is forged and must not be honoured.
  //
  // The fixture scope accepts only the four `FIXTURE_AUDIENCES`, not every
  // `BroadcastAudience`: `everyone` is a real audience, but one this scope
  // cannot mean — it resolves from `memberships`, and `sendBroadcast` nulls
  // the fixture out for it, so honouring it here would turn a submission from
  // a page of four response radios into a game-wide send. It is exactly as
  // forged as any other value with no radio, and takes the same path.
  let audience: BroadcastAudience;
  if (scope === "game") {
    audience = "everyone";
  } else if (body["audience"] === undefined) {
    audience = DEFAULT_FIXTURE_AUDIENCE;
  } else if (isFixtureAudience(body["audience"])) {
    audience = body["audience"];
  } else {
    audience = DEFAULT_FIXTURE_AUDIENCE;
    fail("audience", "Pick who this message goes to.");
  }

  const values: BroadcastFormValues = { subject, message, email, push, audience };

  if (errors.length > 0) return { ok: false, values, errors };
  return { ok: true, values };
}
