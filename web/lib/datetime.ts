/**
 * One clock for the whole app, pinned to the timezone the team works in.
 *
 * WHY THIS EXISTS. Every page formatted its own `Intl.DateTimeFormat` with no
 * `timeZone`, which resolves against whatever the RUNNING PROCESS thinks it
 * is — and that is not one answer:
 *
 *   - A server component renders on Render, where Node's timezone is UTC. The
 *     projects list therefore showed a clip created at 09:48 in Manila as
 *     "1:45 AM", eight hours adrift, with nothing on screen saying so.
 *   - A client component renders in the browser, in the viewer's own zone.
 *     The version picker was already showing Manila time.
 *
 * So the same instant appeared as two different times on two screens of one
 * app, and which one you got depended on a detail nobody can see: whether
 * that particular list happened to be rendered on the server.
 *
 * PINNED, NOT LOCAL. `Asia/Manila` is written down rather than left to the
 * viewer for the same reason the locale is: a fixed format is the one that
 * renders identically on every instance and in every browser, which is what
 * makes two people comparing screens see the same string. Everyone who uses
 * this app is in the Philippines (the operators, the admins, and the four
 * test accounts). If that stops being true, this is the one line to change —
 * and the honest replacement is a per-user preference, not `undefined`,
 * which would quietly reintroduce the server/client split above.
 */
export const APP_TIME_ZONE = "Asia/Manila";

/** "Sep 4, 2026, 9:48 AM" — the format every list and detail row uses. */
export const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: APP_TIME_ZONE,
});

/** "Sat" — for a grant's expiry, where the weekday is the useful part. */
export const weekdayFormatter = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  timeZone: APP_TIME_ZONE,
});

/**
 * "Sep 4, 2026" — where only the day matters.
 *
 * Still pinned: a date with no time is the case where a timezone slip is
 * hardest to notice, because it is only ever wrong for the eight hours
 * either side of midnight and looks right the rest of the day.
 */
export const dateFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeZone: APP_TIME_ZONE,
});
