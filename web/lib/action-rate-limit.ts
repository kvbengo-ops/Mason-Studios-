// Per-user Server Action rate limit, applied in actions/guard.ts's requireUser.
//
// ponytail: in-memory, per process. Resets on every deploy and is only correct
// while the web app runs as ONE instance (Lightsail today). Move the window to a
// table if the web app is ever scaled out.

export const ACTION_LIMIT_PER_MINUTE = 60;
export const READ_LIMIT_PER_MINUTE = 120;
const WINDOW_MS = 60_000;

const hitsByUser = new Map<string, number[]>();
const readHitsByUser = new Map<string, number[]>();

/**
 * Records one Server Action / write API call for `userId` and returns true when it is
 * within the limit. A refused call is not recorded, so retrying while limited
 * cannot extend the lockout.
 */
export function takeActionSlot(userId: string, now: number = Date.now()): boolean {
  const recent = (hitsByUser.get(userId) ?? []).filter((t) => t > now - WINDOW_MS);
  if (recent.length >= ACTION_LIMIT_PER_MINUTE) {
    hitsByUser.set(userId, recent);
    return false;
  }
  recent.push(now);
  hitsByUser.set(userId, recent);
  return true;
}

/**
 * Separate 120/min read bucket for `GET /api/v1/jobs/[id]`, `GET /api/v1/elements`,
 * and `POST /api/v1/quote` so 5-second job polling does not starve write actions.
 */
export function takeReadSlot(userId: string, now: number = Date.now()): boolean {
  const recent = (readHitsByUser.get(userId) ?? []).filter((t) => t > now - WINDOW_MS);
  if (recent.length >= READ_LIMIT_PER_MINUTE) {
    readHitsByUser.set(userId, recent);
    return false;
  }
  recent.push(now);
  readHitsByUser.set(userId, recent);
  return true;
}

/**
 * Computes `Retry-After` seconds (`1..60`) until the oldest hit in the active
 * sliding window expires.
 */
export function retryAfterSeconds(
  userId: string,
  bucket: "write" | "read" = "write",
  now: number = Date.now(),
): number {
  const map = bucket === "read" ? readHitsByUser : hitsByUser;
  const recent = (map.get(userId) ?? []).filter((t) => t > now - WINDOW_MS);
  const oldest = recent[0];
  if (oldest === undefined) return 1;
  return Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000));
}
