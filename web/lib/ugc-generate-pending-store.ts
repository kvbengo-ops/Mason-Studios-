"use client";

import { useSyncExternalStore } from "react";

// A module-level external store — same shape as lib/theme-store.ts's
// subscribe/notify pair, keyed by projectId because /ugc/[id]'s column and
// strip are SIBLINGS under one Server Component page (app/(app)/ugc/[id]/
// page.tsx), with no client provider wrapping both. A module singleton
// reaches across that boundary with no context to thread through a Server
// Component; theme-store.ts already established the pattern for exactly
// this reason.
//
// WHY THIS EXISTS. Generate -> Confirm calls generateClip, which the
// production numbers say takes 4-5s (roughly 15 sequential reads before the
// scene insert, then attachSceneReferences copying each reference one at a
// time — 2.5s for a 4-reference scene). Nothing on screen said so: the
// column's own pending state disables its Generate button, but the strip
// sat still, and editors read a still strip as a stuck one. This store lets
// the strip show a placeholder tile the INSTANT the press is confirmed,
// independent of whichever component eventually learns the real scene id.
//
// NOT useTransition/useOptimistic. "Transition state cannot paint" has
// shipped three times in this project (see the memory of that name) —
// scheduling a paint inside a transition can be starved by whatever else is
// rendering, so the one UI whose entire job is "prove something is
// happening" would be the one state update React is allowed to defer. An
// external store's notify() is a plain synchronous side effect with no
// transition wrapping it, so every subscriber commits before the pending
// scene's own await resumes.
export interface GeneratePendingState {
  /**
   * The new scene's id, once generateClip has returned it — null while the
   * request is still in flight. The placeholder tile watches for this id to
   * show up in the strip's own (server-sourced) scene list, and steps aside
   * itself once it does, rather than being told to by whoever set it.
   */
  sceneId: string | null;
}

/** One row per projectId — the same "no known reset path, cache correctness doesn't matter" shape theme-store.ts describes for its own reads, except this one, unlike a cookie, exists nowhere but here, so it is the source of truth rather than a cache of one. */
const state = new Map<string, GeneratePendingState>();
const listeners = new Map<string, Set<() => void>>();
const timeouts = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * How long a placeholder is allowed to sit before this store gives up on it.
 *
 * Not a normal-path timer — generateClip finishing (however slowly) always
 * clears it sooner via resolveGeneratePending/clearGeneratePending. This is
 * only for the request that never comes back at all (a dropped connection,
 * a server crash mid-request), so a placeholder that would otherwise sit
 * "Queued" forever eventually gives up and lets the operator try again.
 */
const SAFETY_TIMEOUT_MS = 30_000;

function notify(projectId: string): void {
  for (const listener of listeners.get(projectId) ?? []) listener();
}

function clearTimeoutFor(projectId: string): void {
  const timeout = timeouts.get(projectId);
  if (timeout !== undefined) {
    clearTimeout(timeout);
    timeouts.delete(projectId);
  }
}

export function subscribe(projectId: string, listener: () => void): () => void {
  let set = listeners.get(projectId);
  if (!set) {
    set = new Set();
    listeners.set(projectId, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) listeners.delete(projectId);
  };
}

export function getSnapshot(projectId: string): GeneratePendingState | null {
  return state.get(projectId) ?? null;
}

/**
 * True from the confirmed press until the new scene is on screen (or the
 * safety timeout gives up). ugc-column.tsx disables Generate on it, so a
 * second press can't queue a duplicate paid render in the gap between
 * generateClip returning and the strip showing the scene.
 */
export function useIsGeneratePending(projectId: string): boolean {
  return useSyncExternalStore(
    (listener) => subscribe(projectId, listener),
    () => state.has(projectId),
    () => false,
  );
}

/**
 * Call the instant the operator confirms Generate — BEFORE awaiting
 * generateClip, not after. ugc-column.tsx's submit() calls this as its
 * first line for exactly that reason: the placeholder has to exist before
 * the request that will eventually clear it has even started.
 */
export function beginGeneratePending(projectId: string): void {
  armSafetyTimeout(projectId);
  state.set(projectId, { sceneId: null });
  notify(projectId);
}

function armSafetyTimeout(projectId: string): void {
  clearTimeoutFor(projectId);
  timeouts.set(
    projectId,
    setTimeout(() => {
      timeouts.delete(projectId);
      if (state.has(projectId)) {
        state.delete(projectId);
        notify(projectId);
      }
    }, SAFETY_TIMEOUT_MS),
  );
}

/**
 * Call once generateClip resolves with a new scene id. Does NOT hide the
 * placeholder itself — the strip's own pending-tile component clears the
 * store once that id actually shows up among the real scenes it was passed,
 * so there is never a gap between the placeholder disappearing and the real
 * tile appearing.
 */
export function resolveGeneratePending(projectId: string, sceneId: string): void {
  if (!state.has(projectId)) return; // already cleared (timeout, or a second press)
  // RE-ARMED, not cancelled: generateClip coming back is not the end of the
  // wait, only the start of a shorter one — the placeholder still has to
  // sit until the strip's own next server render actually lists this id
  // (see ugc-pending-scene-tile.tsx), and that catch-up deserves the same
  // safety net the request itself had.
  armSafetyTimeout(projectId);
  state.set(projectId, { sceneId });
  notify(projectId);
}

/** Call on an {error} result or a thrown action — there is no scene coming, so nothing to wait for. */
export function clearGeneratePending(projectId: string): void {
  clearTimeoutFor(projectId);
  if (state.delete(projectId)) notify(projectId);
}

/**
 * Test-only reset. The store above is a module singleton, so unlike a
 * per-render useState it survives across `it()` blocks in the same test
 * file — tests that call begin/resolve/clear must reset the projectId(s)
 * they touched in afterEach, or one test's pending scene leaks into the
 * next.
 */
export function __resetAllGeneratePendingForTests(): void {
  for (const projectId of Array.from(timeouts.keys())) clearTimeoutFor(projectId);
  state.clear();
  listeners.clear();
}
