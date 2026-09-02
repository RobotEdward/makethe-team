/**
 * "1st", "2nd", "3rd", "4th" — English ordinals, with the 11-13 exception.
 *
 * In `domain` rather than beside the squad row it was written for (M46): the
 * fixture timeline needs the same words, and `src/domain` importing from
 * `src/views` to get them would be the only such import in the codebase and an
 * inversion of the layering everything else follows.
 */
export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}
