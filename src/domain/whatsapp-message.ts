/**
 * The words an organiser pastes into their WhatsApp group (M22).
 *
 * Pure text, built once here so the owner fixture page, the cancelled page
 * and the organiser's nudge all hand over the same message. Nothing in any
 * of these is personal to one player: a response token in a group chat would
 * let anyone answer as someone else, and the product never stores a phone
 * number, so a group message is the one channel it cannot address.
 *
 * **Two links, and the organiser chooses which go out (M38).** Until M38 the
 * only link was the game page, on the reasoning that everybody reading is a
 * squad member who signs in. That reasoning was sound and the practice was
 * not: organisers post this into the group chat where the *next* player is
 * also reading, and a `/g/:id` link answers a non-member with a 404. So the
 * message can also carry the public invite link. It is a capability — see
 * `docs/known-issues.md` on what a leaked one costs — which is exactly why
 * it is a switch on the card rather than an unconditional line here.
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
  /** Absolute URL of the public `/j/:token` invite page, for a new player. */
  inviteUrl: string;
}

/**
 * A trailing line of `openMessage` the organiser can switch off on the card.
 *
 * `label` is the checkbox's words, so the two cannot drift apart, and `key`
 * is stable for tests rather than for storage — nothing persists the choice.
 */
export interface OpenMessageOption {
  key: "squad" | "invite";
  label: string;
  line: string;
}

/**
 * `openMessage` split into the part that is always sent and the parts that
 * are switchable, in the order they appear in the message.
 *
 * The card renders `fixed` plus every option into the textarea and lets a
 * script subtract the unticked ones (`WHATSAPP_LINKS_JS`), so with scripting
 * off the message is simply the whole thing — the links are what the
 * organiser needs, and the switches are the sugar.
 */
export interface OpenMessageParts {
  fixed: string;
  options: readonly OpenMessageOption[];
}

/**
 * "It's open" and "reminder with current numbers" are one message: the
 * numbers line says which it is, and the organiser adds their own chasing.
 */
export function openMessageParts(facts: OpenMessageFacts): OpenMessageParts {
  const { gameName, venueName, kicksOffAtLocal, inCount, minPlayers, maxPlayers } = facts;
  return {
    fixed: [
      `⚽ ${gameName} — ${kicksOffAtLocal} at ${venueName}`,
      numbersLine(inCount, minPlayers, maxPlayers),
    ].join("\n"),
    // Squad first: it is the line that has always been here, and the one most
    // of the group is acting on. The invite line reads as a footnote for the
    // one person it is for, which is what it is.
    options: [
      {
        key: "squad",
        label: "Link for the squad",
        line: `In or out? Say so on Make The Team: ${facts.gameUrl}`,
      },
      {
        key: "invite",
        label: "Link for someone new",
        line: `New to the squad? Join here: ${facts.inviteUrl}`,
      },
    ],
  };
}

/** Every line, every link — what a browser with no scripting is handed. */
export function openMessage(facts: OpenMessageFacts): string {
  const { fixed, options } = openMessageParts(facts);
  return [fixed, ...options.map((option) => option.line)].join("\n");
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
