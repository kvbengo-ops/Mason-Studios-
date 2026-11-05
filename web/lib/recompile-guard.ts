// Pulled out of actions/compile.ts (a "use server" file, where every export
// must be an async Server Action) so this pure check stays a plain,
// synchronous, unit-testable function.

import type { SceneStatus } from "@/types/db";

// Scene statuses that have not yet been submitted for rendering. Anything
// past these means fal money has already been spent on this project (see
// docs/architecture.md § "The contract" — web owns draft/frame_ready/queued,
// go owns queued onward), so a recompile must refuse rather than blow away
// scenes that cost real money to produce.
/**
 * Deliberately its OWN list, not lib/editable-guard.ts's EDITABLE_STATUSES.
 *
 * The two answer different questions and have already drifted apart once.
 * "Can this scene be edited?" widened to include rendered scenes, because a
 * re-render opens a new version rather than overwriting a clip. "Has this
 * project spent render money yet?" did not widen, and must not: recompiling
 * DELETES every scene row, and a deleted scene takes its versions and its
 * paid-for clips with it (0058's ON DELETE CASCADE).
 */
const PRE_RENDER_STATUSES: readonly SceneStatus[] = ["draft", "frame_ready"];

/** True once any scene has left draft/frame_ready — i.e. recompiling would destroy paid work. */
export function hasStartedRendering(scenes: { status: SceneStatus }[]): boolean {
  return scenes.some((scene) => !PRE_RENDER_STATUSES.includes(scene.status));
}

/**
 * Throws if any scene has progressed past frame_ready.
 */
export function assertRecompilable(scenes: { status: SceneStatus }[]): void {
  const started = scenes.filter((scene) => !PRE_RENDER_STATUSES.includes(scene.status));
  if (started.length > 0) {
    throw new Error(
      "Rendering has already started on this project — recompiling would destroy scenes " +
        "that cost real money to produce. Duplicate the project instead and recompile the copy.",
    );
  }
}
