/**
 * The one rule about what a Player may call themselves (M11).
 *
 * Its own module, and not an `if` inside `POST /app/account`, for the reason
 * `src/domain/game-form.ts` is its own module: the route's job is to write a
 * row and answer, and a validation rule inlined at the one call site that
 * needs it today is a rule the next call site will restate slightly
 * differently. `MAX_LENGTH` matches `MAX_NAME_LENGTH` in `game-form.ts` — the
 * same question about the same kind of free text, deliberately given the same
 * answer.
 */

const MAX_LENGTH = 200;

export type PlayerNameResult =
  | { ok: true; name: string }
  | { ok: false; problem: string };

/**
 * Validate a submitted name.
 *
 * Takes `unknown` rather than `string` because its caller's input is
 * `c.req.parseBody()`, which hands back `string | File` for a present field
 * and `undefined` for an absent one. Narrowing here rather than at the call
 * site means the route cannot forget to.
 *
 * An empty name is refused rather than quietly ignored. A blank in a squad
 * list is worse than a refusal: it appears in every fixture page, every
 * reminder email and every organiser's roster, and nobody reading one can tell
 * whether it is a bug or a person.
 */
export function parsePlayerName(raw: unknown): PlayerNameResult {
  if (typeof raw !== "string") {
    return { ok: false, problem: "Tell us what to call you." };
  }
  const name = raw.trim();
  if (name.length === 0) {
    return { ok: false, problem: "Tell us what to call you." };
  }
  if (name.length > MAX_LENGTH) {
    return { ok: false, problem: `Keep your name under ${MAX_LENGTH} characters.` };
  }
  return { ok: true, name };
}
