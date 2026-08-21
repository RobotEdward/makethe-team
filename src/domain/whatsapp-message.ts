/**
 * The words an organiser pastes into their WhatsApp group (M22).
 *
 * Pure text, built once here so the owner fixture page, the cancelled page
 * and the organiser's nudge all hand over the same message. Nothing in any
 * of these is personal to one player: the only link is the game page, which
 * every squad member signs in to — a response token in a group chat would
 * let anyone answer as someone else, and the product never stores a phone
 * number, so a group message is the one channel it cannot address.
 *
 * `kicksOffAtLocal` arrives already formatted: all timezone conversion goes
 * through `formatLocalDateTime` at the caller (TR-5), never here.
 */

export interface OpenMessageFacts {
  gameName: string;
  venueName: string;
  kicksOffAtLocal: string;
  inCount: number;
  minPlayers: number;
  maxPlayers: number;
  /** Absolute URL of the game page, where a signed-in member answers. */
  gameUrl: string;
}

/**
 * "It's open" and "reminder with current numbers" are one message: the
 * numbers line says which it is, and the organiser adds their own chasing.
 */
export function openMessage(facts: OpenMessageFacts): string {
  const { gameName, venueName, kicksOffAtLocal, inCount, minPlayers, maxPlayers, gameUrl } = facts;
  return [
    `⚽ ${gameName} — ${kicksOffAtLocal} at ${venueName}`,
    numbersLine(inCount, minPlayers, maxPlayers),
    `In or out? Say so on Make The Team: ${gameUrl}`,
  ].join("\n");
}

function numbersLine(inCount: number, minPlayers: number, maxPlayers: number): string {
  if (inCount >= maxPlayers) return `${inCount} in — full, but you can join the waitlist.`;
  if (inCount < minPlayers) {
    return `${inCount} in so far — ${minPlayers - inCount} more needed.`;
  }
  const left = maxPlayers - inCount;
  return `${inCount} in, ${left} ${left === 1 ? "spot" : "spots"} left.`;
}

export interface TeamsMessageFacts {
  gameName: string;
  kicksOffAtLocal: string;
  lineUps: readonly { name: string; players: readonly string[] }[];
}

export function teamsMessage({ gameName, kicksOffAtLocal, lineUps }: TeamsMessageFacts): string {
  const sides = lineUps.map(
    (side) => `${side.name}: ${side.players.length === 0 ? "nobody yet" : side.players.join(", ")}`,
  );
  return [`⚽ ${gameName} — ${kicksOffAtLocal}`, "Teams:", ...sides].join("\n");
}

export interface CancelledMessageFacts {
  gameName: string;
  kicksOffAtLocal: string;
  /** The organiser's reason; blank or null means there isn't one. */
  reason: string | null;
}

export function cancelledMessage({ gameName, kicksOffAtLocal, reason }: CancelledMessageFacts): string {
  const first = `${gameName} on ${kicksOffAtLocal} is cancelled.`;
  const trimmed = reason?.trim() ?? "";
  return trimmed === "" ? first : `${first}\n${trimmed}`;
}

/**
 * An organiser broadcast, as typed. Only ever built in the browser from the
 * compose form (`BROADCAST_WHATSAPP_JS`), because the body is deliberately
 * never stored (M15 spec §8) — this server-side twin exists so the test can
 * pin the shape the script must produce.
 */
export function broadcastMessage({ subject, message }: { subject: string; message: string }): string {
  const head = subject.trim();
  return head === "" ? message : `${head}\n\n${message}`;
}

/**
 * Opens WhatsApp with `text` prefilled and lets the person pick the chat.
 * `encodeURIComponent`, not `URLSearchParams`: the latter encodes a space as
 * `+`, which WhatsApp's deep link shows literally.
 */
export function whatsappShareUrl(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}
