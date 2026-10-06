/**
 * Admin dates are Montréal wall-clock time (America/Toronto), because that is where the
 * campaign runs. Forms send "2026-10-15T00:00"; this turns it into the right instant across
 * daylight saving, and back.
 */
const TZ = "America/Toronto";

const parts = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function wall(ms: number) {
  const get = (type: string) =>
    Number(parts.formatToParts(new Date(ms)).find((p) => p.type === type)?.value);
  return {
    y: get("year"),
    mo: get("month"),
    d: get("day"),
    h: get("hour"),
    mi: get("minute"),
    s: get("second"),
  };
}

/** Minutes the Montréal clock is ahead of UTC at that instant (-240 in summer, -300 in winter). */
function offsetMinutes(ms: number): number {
  const w = wall(ms);
  return (Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000) / 60_000;
}

/**
 * "YYYY-MM-DD" (taken as the start of that day) or "YYYY-MM-DDTHH:mm" in Montréal time, as a
 * Date. Null when it isn't a real date and time.
 */
export function parseMontrealLocal(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(value.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [h, mi] = [Number(m[4] ?? 0), Number(m[5] ?? 0)];
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  if (Number.isNaN(naive)) return null;
  // Two passes settle the offset on the right side of a daylight-saving change.
  let ms = naive - offsetMinutes(naive) * 60_000;
  ms = naive - offsetMinutes(ms) * 60_000;
  const back = wall(ms);
  if (back.y !== y || back.mo !== mo || back.d !== d || back.h !== h || back.mi !== mi) return null;
  return new Date(ms);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** For <input type="datetime-local">: "2026-10-15T00:00" in Montréal time. */
export function toMontrealLocal(date: Date | null): string {
  if (!date) return "";
  const w = wall(date.getTime());
  return `${w.y}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}`;
}

/** "2026-10-15 00:00" for tables. */
export function formatMontreal(date: Date | string | null): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  return toMontrealLocal(d).replace("T", " ");
}
