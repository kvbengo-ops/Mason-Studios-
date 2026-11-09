/** An account counts as online for this long after its last heartbeat (2 minutes). */
export const PRESENCE_WINDOW_MS = 2 * 60_000;

/** How often the layout's heartbeat fires while a tab is visible. */
export const PRESENCE_INTERVAL_MS = 60_000;

export function isOnline(lastSeenAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!lastSeenAt) return false;
  const seen = Date.parse(lastSeenAt);
  return Number.isFinite(seen) && now.getTime() - seen <= PRESENCE_WINDOW_MS;
}

/** The dot's tooltip: "Online", or when the account was last seen. */
export function lastSeenLabel(lastSeenAt: string | null | undefined, now: Date = new Date()): string {
  if (!lastSeenAt || !Number.isFinite(Date.parse(lastSeenAt))) return "Never seen";
  if (isOnline(lastSeenAt, now)) return "Online now";
  const minutes = Math.floor((now.getTime() - Date.parse(lastSeenAt)) / 60_000);
  if (minutes < 60) return `Last seen ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Last seen ${hours} h ago`;
  return `Last seen ${Math.floor(hours / 24)} d ago`;
}
