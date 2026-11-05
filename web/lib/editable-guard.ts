// Single source of truth for "can THIS SCENE's brief still be edited?" —
// a per-scene, workflow-stage question, and deliberately NOT the same
// question as "is the PROJECT still open for changes?" The latter is
// answered by lib/project-status.ts / projects.status === 'delivered' (see
// actions/deliver.ts's markDelivered/reopenProject) — the commitment point
// the pipeline actually cares about is a human clicking Deliver, not a
// scene leaving frame_ready. Every project-level lock in this codebase
// (character/page.tsx, actions/character.ts, actions/character-library.ts,
// actions/project.ts) now reads `project.status === 'delivered'` directly
// instead of asking this file anything — regenerating a character
// reference or editing the script after a scene has rendered doesn't
// corrupt anything (a re-render brings it back in sync), it just needs a
// visible "existing clips are now stale" warning, which is a UI concern,
// not a write refusal.
//
// What DOES still belong here is concurrency: a scene the worker is
// currently claiming/rendering must not have its own row rewritten out from
// under it. isEditable (draft/frame_ready only) is the per-scene text/frame
// gate actions/brief.ts's assertEditable and actions/frames.ts's own copy
// enforce — a 'done' or 'failed' scene doesn't reach the worker again
// without going through an explicit, warned correction path first
// (unfreezeScene for 'done', retryScene for 'failed'), so a bare textarea
// edit is refused for those too, not just for 'queued'/'rendering'.
// isSceneInFlight below is the narrower, PURELY concurrency-scoped
// predicate — 'queued'/'rendering' only — for the one place that isn't
// about a specific scene's own text at all: actions/render-settings.ts,
// where the worker reads projects.render_settings fresh at dispatch time
// (worker/internal/loop/dispatch.go), so changing it while anything is
// actually in flight would change what an already-submitted-but-not-yet-
// claimed scene renders with, not just leave a stale record. A 'done' or
// 'failed' scene has nothing in flight to disturb, so it doesn't belong in
// this set the way it belongs in EDITABLE_STATUSES's complement above.
//
// Three call sites used to each keep their own copy of the EDITABLE_STATUSES
// list (actions/brief.ts, components/frame-grid.tsx, components/scene-table.tsx)
// — a server-side guard and two UI predicates that had to stay in sync by
// hand. actions/brief.ts's assertEditable is the real boundary (it's the
// one that can't be bypassed); the UI predicates here exist only so the
// interface stops offering an ability the server will refuse — an editable
// textarea and buttons that error out on submit instead of just not being
// there. See docs/architecture.md § "The contract": web owns
// draft/frame_ready, go owns queued onward.

import type { SceneStatus } from "@/types/db";

/**
 * Scenes at or before this stage are still free to edit — no render money
 * spent yet.
 *
 * DO NOT widen this to include rendered scenes. It was widened once, to let
 * a finished scene's prompt and frame be edited, and it silently changed
 * the answer to a completely different question that eleven other call
 * sites ask through the same function: "has this project spent render money
 * yet?". scenesAwaitingRender (lib/enqueue-guard.ts) swept every finished
 * scene back into a fresh batch; the Script page offered Recompile on a
 * project with six paid clips. Editing a rendered scene is
 * isSceneContentEditable below — a different question, its own predicate.
 */
export const EDITABLE_STATUSES: readonly SceneStatus[] = ["draft", "frame_ready"];

/**
 * Whether this scene's PROMPT, FRAME and version can be changed right now.
 *
 * True for everything except the two statuses the worker owns. While a
 * scene is 'queued' or 'rendering' the worker has claimed it and is reading
 * these exact columns, so an edit would either be ignored or race the
 * submit. A 'done' or 'failed' scene is nobody's but the operator's: a
 * re-render opens a new version rather than overwriting the clip
 * (0058_scene_versions.sql), so there is nothing left to protect.
 *
 * Deliberately NOT the same function as isEditable — see EDITABLE_STATUSES.
 */
export function isSceneContentEditable(status: SceneStatus): boolean {
  return status !== "queued" && status !== "rendering";
}

export function isEditable(status: SceneStatus): boolean {
  return EDITABLE_STATUSES.includes(status);
}

/**
 * True only for 'queued'/'rendering' — the two statuses that mean the
 * worker currently owns this scene (has claimed it, or will claim it off
 * the queue at any moment). This is the pure concurrency predicate: unlike
 * isEditable above, 'done' and 'failed' are NOT included here, because
 * nothing is in flight for either — a finished or failed scene can't have
 * its dispatch corrupted by a project-level settings change, only its own
 * (already-produced-or-never-attempted) clip made stale, which is a warning
 * concern, not a concurrency one. See this file's header comment for the
 * one caller that needs exactly this set: actions/render-settings.ts.
 */
export function isSceneInFlight(status: SceneStatus): boolean {
  return status === "queued" || status === "rendering";
}

/**
 * Throws unless every scene that has already left draft/frame_ready keeps
 * the same relative order in `orderedIds` that it had in `existing`.
 *
 * A reorder is free to shuffle scenes still in draft/frame_ready however
 * the operator likes — no render money is committed on those yet. But once
 * a scene has rendered, its position is part of what was already paid for:
 * moving it relative to another rendered scene would silently change what
 * "scene N" means in the assembled video without re-rendering anything —
 * the same class of bug as regenerating a character reference mid-render
 * (see character/page.tsx's lock). Locked scenes may still shift index as
 * pre-render scenes are inserted or removed around them (lib/scene-order.ts
 * repacks everyone) — only their order *relative to each other* is what
 * this protects.
 *
 * The one sanctioned caller that does NOT run this guard is
 * reorderCut (actions/deliver.ts) — the assembled-cut reorder on the
 * Deliver page, where every scene being 'done'/'failed' already is the
 * point (there is nothing left in draft/frame_ready to protect), and an
 * explicit, operator-initiated reassembleProject rebuilds the `final` in
 * the new order rather than leaving it silently stale. That exception is
 * scoped to reorderCut's own precondition (every scene terminal); it is not
 * a reason to weaken or remove this function, which stays the guard for
 * reorderScenes and the brief stage exactly as written above.
 */
export function assertLockedOrderPreserved(
  existing: readonly { id: string; status: SceneStatus }[],
  orderedIds: readonly string[],
): void {
  const lockedIds = existing.filter((scene) => !isEditable(scene.status)).map((scene) => scene.id);
  const lockedIdSet = new Set(lockedIds);
  const lockedInNewOrder = orderedIds.filter((id) => lockedIdSet.has(id));

  const unchanged =
    lockedIds.length === lockedInNewOrder.length &&
    lockedIds.every((id, index) => id === lockedInNewOrder[index]);

  if (!unchanged) {
    throw new Error(
      `${lockedIds.length} scene(s) in this project have already rendered — their order is ` +
        "locked. Scenes still in draft/frame_ready can still be freely reordered.",
    );
  }
}
