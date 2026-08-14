/** The longest guest name the form accepts. Generous, and bounded. */
const MAX_GUEST_NAME = 80;

export type GuestNameResult = { ok: true; name: string } | { ok: false; problem: string };

/**
 * Parse the one field the add-a-guest form has (§5).
 *
 * Returns a message the page can render rather than throwing: an owner
 * mistyping a name is an ordinary event on an ordinary form, not an error.
 * Escaping is `escapeHtml`'s job at render time, as everywhere else — this
 * function decides what is *acceptable*, never what is *safe to print*.
 */
export function parseGuestName(raw: unknown): GuestNameResult {
  if (typeof raw !== "string") return { ok: false, problem: "Give your guest a name." };
  const name = raw.trim();
  if (name === "") return { ok: false, problem: "Give your guest a name." };
  if (name.length > MAX_GUEST_NAME) {
    return { ok: false, problem: "That name is too long — keep it under 80 characters." };
  }
  return { ok: true, name };
}
