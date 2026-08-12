/**
 * The states a Player's Response to a Fixture can be in (§1.8).
 *
 * Canonical definition. The Drizzle column and every union type derive from
 * this, so a value added here without updating a consumer is a typecheck error
 * rather than silent drift.
 */
export const RESPONSE_STATUSES = ["pending", "in", "out", "waitlisted", "withdrawn"] as const;

export type ResponseStatus = (typeof RESPONSE_STATUSES)[number];

export const INITIAL_RESPONSE_STATUS: ResponseStatus = "pending";

/** How a response came to be set (§2.8). */
export const RESPONSE_SOURCES = ["token", "web", "owner", "system"] as const;

export type ResponseSource = (typeof RESPONSE_SOURCES)[number];

/**
 * Whether a status consumes one of the fixture's slots.
 *
 * Only `in` does. `waitlisted` wants a slot but does not hold one, and
 * `withdrawn` explicitly frees the one it held (BR-3) without reading as a
 * decline the way `out` does.
 */
export function occupiesSlot(status: ResponseStatus): boolean {
  return status === "in";
}

/**
 * BR-20: who gets told a fixture was cancelled. Exactly the Players who held
 * or wanted a slot — `in` or `waitlisted` — and never a guest, who has no
 * address to mail (BR-32). `pending`, `out`, and `withdrawn` never receive
 * this message: `pending` and `out` never committed to the slot, and
 * `withdrawn` explicitly gave it back.
 *
 * A pure predicate rather than a query, so the recipient rule can be pinned
 * here, independently of however the wiring task ends up selecting rows.
 */
export function isCancellationRecipient(status: ResponseStatus, isGuest: boolean): boolean {
  if (isGuest) return false;
  return status === "in" || status === "waitlisted";
}
