// Per-user Server Action rate limit, applied in actions/guard.ts's requireUser.
//
// ponytail: in-memory, per process. Resets on every deploy and is only correct
// while the web app runs as ONE instance (Lightsail today). Move the window to a
// table if the web app is ever scaled out.

export const ACTION_LIMIT_PER_MINUTE = 60;
const WINDOW_MS = 60_000;

const hitsByUser = new Map<string, number[]>();

/**
 * Records one Server Action call for `userId` and returns true when it is
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
