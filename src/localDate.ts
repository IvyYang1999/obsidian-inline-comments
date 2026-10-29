/** Today on this machine's calendar (YYYY-MM-DD) — not UTC, which is a day off for half the world part of the day */
export function localIsoDate(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
