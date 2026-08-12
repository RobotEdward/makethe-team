/**
 * A squad member's name as a visitor holding an invite link may see it (BR-26):
 * first name plus surname initial, "Edward C.".
 *
 * One implementation, because BR-26 is a privacy rule rather than a formatting
 * preference — a second copy on some other page is how a full surname
 * eventually ships. The public invite page is its only caller today; any future
 * public surface must call this rather than interpolate `players.name`.
 *
 * A single-word name is returned unchanged. There is no surname to reduce, and
 * fabricating an initial would show something the person never entered.
 */
export function redactName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter((part) => part !== "");
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0]!;

  const first = parts[0]!;
  const surname = parts[parts.length - 1]!;
  return `${first} ${surname[0]!.toUpperCase()}.`;
}
