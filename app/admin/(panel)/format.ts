/** Number and date formatting shared by the admin pages. */
const numbers = new Intl.NumberFormat("en-CA");

export const n = (value: number): string => numbers.format(value);

/** "42%" of part over whole; a dash when there is no whole. */
export function pct(part: number, whole: number, digits = 0): string {
  if (!whole) return "—";
  return `${((part / whole) * 100).toFixed(digits)}%`;
}
