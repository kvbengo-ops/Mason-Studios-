// Server-side render timing for authenticated pages, emitted as one
// structured log line per instrumented render. Exists to answer a question
// nobody could answer before it: users report authenticated pages are
// slow, and there is no production measurement of a signed-in render on
// Render — /login (unauthenticated) is fast, so the server itself is fine,
// but nothing has ever timed requireUser(), the sidebar budget read,
// avatar signing, or a page's own data fetching separately. Ship
// instrumentation, read real numbers, then fix what they point at — do not
// guess again.
//
// Flag: PERF_LOGGING_ENABLED. Follows the AUDIO_ENABLED/CAPTIONS_ENABLED
// convention (render.yaml, `=== "1"` checks so an absent var means off) —
// see lib/models.ts's isAudioEnabled — rather than inventing a new on/off
// idiom. render.yaml declares it "1" for now: the whole point is to
// collect numbers from real, signed-in traffic. It is expected to be
// turned back off (or this file deleted) once that question is answered —
// this is diagnostic instrumentation, not a permanent feature.
//
// House style: one line, key=value pairs, matching how the Go worker logs
// with slog (see worker/internal/loop/dispatch.go) in spirit. Never logs a
// key value, a user email, a project title, script text, or any other
// user-authored content — a user id is the only per-user identifier this
// file ever writes to a log line.
//
// Safety contract, because this wraps every authenticated route
// (app/(app)/layout.tsx wraps every page under it) and must never itself
// become the outage:
//   - step() never adds an extra await to the critical path. It attaches a
//     `.finally()` to a promise that is ALREADY in flight, which runs as a
//     side effect when that promise settles — it does not delay or
//     serialize anything a Promise.all was already doing in parallel.
//   - step() never changes what the wrapped promise resolves or rejects
//     with. The exact value or error passes through unchanged, so a
//     caller's existing fail-soft handling (e.g. lib/sidebar-budget.ts's
//     own try/catch around getAccountBudgetSnapshot) behaves exactly as it
//     did before this file existed — this file must not convert a
//     rejection into a different shape, or swallow one that a caller was
//     relying on seeing.
//   - Every bit of recording/formatting/logging work is wrapped in
//     try/catch. A bug in this file must degrade to "this render didn't
//     get logged," never to a broken page.

const ENABLED_ENV_VALUE = "1";

/**
 * PERF_LOGGING_ENABLED=1 gates every export in this file. Read from
 * process.env on every call (not cached at module load) so tests can flip
 * it between assertions and so a runtime env change (rare, but this is
 * exactly the flag meant to be flipped off once the question it exists for
 * is answered) takes effect without a redeploy of this module's state.
 */
export function isPerfLoggingEnabled(): boolean {
  return process.env.PERF_LOGGING_ENABLED === ENABLED_ENV_VALUE;
}

// How long a route may go unvisited before its next render counts as
// "cold" rather than "warm" — long enough that ordinary request spacing on
// a lightly-used internal tool doesn't get misread as a cold start, short
// enough to still catch "nobody hit this page for a while" (an idle
// period) as well as "the process just started" (a deploy).
const COLD_THRESHOLD_MS = 30_000;

// Per-route "last seen" clock, not one process-wide clock. app/(app)/
// layout.tsx and each page it wraps are timed and logged as separate
// renders (see this file's callers) — a page's own coldness ("has
// anything hit THIS route recently") is the useful signal. A single
// shared clock would make every page after the first one in a request
// read as warm just because the shell's own step ran a few milliseconds
// earlier in the same request, which isn't the question this is for.
const lastSeenAtByRoute = new Map<string, number>();

/**
 * True if this is the first render of `route` in this process, or the
 * first one in more than COLD_THRESHOLD_MS — i.e. plausibly a deploy or an
 * idle period rather than a warm, steadily-loaded server. Updates the
 * per-route clock as a side effect, so this must be called exactly once
 * per render (RenderTimer.finish does this; nothing else should call it
 * directly).
 */
function isColdRender(route: string): boolean {
  const now = Date.now();
  const lastSeenAt = lastSeenAtByRoute.get(route);
  lastSeenAtByRoute.set(route, now);
  return lastSeenAt === undefined || now - lastSeenAt > COLD_THRESHOLD_MS;
}

/**
 * Logged once, when the server process starts — call this from
 * instrumentation.ts's register(), not from a request path. Lets a slow
 * render be told apart from a slow COLD render after a deploy: grep for
 * this line's timestamp and compare it against a render line's own time to
 * see how soon after boot it happened. (Per-render `cold=` on
 * perf_render lines above already answers the idle-period half of the same
 * question; this answers the deploy half, which a per-route clock that
 * starts empty on every fresh process can't distinguish from "first visit
 * ever, but the server's been up for hours.")
 */
export function logColdStartMarker(): void {
  if (!isPerfLoggingEnabled()) return;
  try {
    console.log(`perf_boot: pid=${process.pid} startedAt=${new Date().toISOString()}`);
  } catch {
    // Never let a logging failure affect server startup.
  }
}

/**
 * Accumulates named step durations for one render and emits a single
 * structured log line for it. One instance per render: construct it at the
 * top of the Server Component/layout, wrap each independently-awaited
 * piece of work in .step(), then call .finish() once, after everything the
 * render needed has resolved (or failed — step() passes rejections through
 * unchanged, so a render that throws still has its earlier steps recorded
 * up to that point; nothing here needs its own try/catch around a page's
 * own logic).
 */
export class RenderTimer {
  private readonly route: string;
  private readonly startedAt: number;
  private readonly steps: Array<[string, number]> = [];

  constructor(route: string) {
    this.route = route;
    this.startedAt = performance.now();
  }

  /**
   * Wraps an already-in-flight promise to record how long it took, without
   * changing its resolution, its rejection, or when it settles. Safe to
   * use inside a Promise.all — the timing side effect rides along on
   * `.finally()`, so nothing here becomes a new thing to await, and
   * nothing here delays the Promise.all resolving.
   *
   * `promise` must already be a call in progress (e.g.
   * `timer.step("budget", getSidebarBudget(userId, profile))`), not a
   * function to invoke later — passing an unstarted thunk would risk
   * accidentally sequencing work that used to run in parallel, which is
   * exactly the regression this file exists to avoid introducing.
   */
  step<T>(label: string, promise: Promise<T>): Promise<T> {
    if (!isPerfLoggingEnabled()) return promise;
    const start = performance.now();
    return promise.finally(() => {
      try {
        this.steps.push([label, Math.round(performance.now() - start)]);
      } catch {
        // Never let recording a step break the render it's timing.
      }
    });
  }

  /**
   * Emits the one log line for this render. Safe to call unconditionally —
   * does nothing when the flag is off, and never throws, so it's safe to
   * call as the last line of a render function without wrapping it.
   */
  finish(context: { userId: string | null }): void {
    if (!isPerfLoggingEnabled()) return;
    try {
      const totalMs = Math.round(performance.now() - this.startedAt);
      const cold = isColdRender(this.route);
      const parts = [
        `perf_render: route=${this.route}`,
        `cold=${cold}`,
        ...this.steps.map(([label, ms]) => `${label}_ms=${ms}`),
        `total_ms=${totalMs}`,
      ];
      if (context.userId) {
        parts.push(`user=${context.userId}`);
      }
      console.log(parts.join(" "));
    } catch {
      // Never let logging a render's timing break the render itself.
    }
  }
}
