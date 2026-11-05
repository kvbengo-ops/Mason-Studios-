// Pulled out of components/render-progress.tsx so the elapsed-time math is a
// plain, synchronous, unit-testable function (same pattern as
// recompile-guard.ts / enqueue-guard.ts). This file has no React or
// Supabase dependency.

import type { SceneStatus } from "@/types/db";

// The statuses that mean a scene is actually with the worker right now, and
// so the only ones the elapsed clock has anything to measure.
//
// Not "everything except done and failed", which is what this used to be:
// after a partial render (enqueueTestScene), the untouched scenes sit at
// frame_ready, which counted as still-waiting even though they had never
// been submitted and had no submitted_at to measure from. The readout then
// showed a bare em dash indefinitely, on a page whose entire job is to say
// how long the wait has been.
const IN_FLIGHT_SCENE_STATUSES: readonly SceneStatus[] = ["queued", "rendering"];

/**
 * The start of what's still being waited on: the earliest `submitted_at`
 * among scenes that haven't reached a terminal status yet. `submitted_at`
 * is stamped by the Go worker's ClaimQueuedScenes at claim time
 * (worker/internal/store/store.go), not by this page loading — so, unlike
 * `Date.now()` at mount, it survives reloads and reflects when the
 * in-flight work actually started.
 *
 * Deliberately scoped to in-flight scenes only, not all of them. A
 * finished scene's `submitted_at` describes when *that* scene started, not
 * anything about the batch someone is currently waiting on — mixing it
 * into the minimum is how a single re-rendered scene (rerenderScene in
 * actions/enqueue.ts, which stamps a fresh submitted_at on just that one
 * scene) ends up reporting the age of the whole project instead of its own
 * few seconds. Once nothing is in flight, this returns null and the caller
 * shows no elapsed readout at all (see isRenderInFlight).
 *
 * Returns null when no in-flight scene has been claimed yet (still
 * `queued`) or when there is nothing in flight to measure. In that case
 * there is no real origin to measure elapsed time from.
 */
export function renderOriginMs(
  scenes: readonly { submitted_at: string | null; status: SceneStatus }[],
): number | null {
  const claimedAt = scenes
    .filter((scene) => IN_FLIGHT_SCENE_STATUSES.includes(scene.status))
    .map((scene) => scene.submitted_at)
    .filter((ts): ts is string => ts !== null)
    .map((ts) => new Date(ts).getTime());
  if (claimedAt.length === 0) {
    return null;
  }
  return Math.min(...claimedAt);
}

/**
 * True while any scene is still queued/rendering (or even pre-render) —
 * i.e. there is work the worker hasn't finished yet, so the elapsed-time
 * timer should keep ticking. False once every scene has reached a terminal
 * status, at which point the timer should freeze instead of running
 * forever on a page nobody is waiting on anymore.
 */
export function isRenderInFlight(scenes: readonly { status: SceneStatus }[]): boolean {
  return scenes.some((scene) => IN_FLIGHT_SCENE_STATUSES.includes(scene.status));
}

/**
 * Formats elapsed milliseconds as `m:ss`. `elapsedMs === null` means there
 * is no origin to measure from (nothing submitted yet — see
 * renderOriginMs) — render an em dash rather than let `Date.now() - null`
 * or similar coerce into NaN/"NaN:NaN" downstream.
 */
export function elapsedLabel(elapsedMs: number | null): string {
  if (elapsedMs === null) {
    return "—";
  }
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
