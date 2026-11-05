import type { ProjectStatus, SceneStatus } from "@/types/db";
import { isEditable } from "@/lib/editable-guard";

// docs/architecture.md § "User flow": each project status maps to exactly
// one step of the pipeline. Single source of truth for that mapping —
// app/(app)/projects/[id]/page.tsx uses it to redirect a bare
// /projects/[id] link to the operator's CURRENT step. It briefly had a
// second reader — a per-row action on the /projects list — which was
// removed at the operator's request; the rule that outlived it is the
// reason it was written this way: two mappings of status -> route is
// exactly the kind of drift this repo has
// scar tissue over (see this file's other doc comments, and
// 0029_project_directory.sql's header, for the "second copy of a
// derivation" failure mode). NOT used for reachability — see
// deriveReachedSteps below for why "current step" and "every step the
// project has ever reached" had to become two different questions. Kept out
// of page.tsx so this module (consumed by step-rail.tsx, a Client Component)
// doesn't pull that Server Component's module graph (next/headers, etc.)
// into the client bundle.
export const STATUS_ROUTE: Record<ProjectStatus, keyof ReachedSteps> = {
  draft: "character",
  briefed: "brief",
  framed: "frames",
  rendering: "render",
  // Not "render": 'complete' means every scene has left queued/rendering —
  // there is nothing left on the render screen to watch, whether or not
  // every clip succeeded (see deriveProjectStatus's doc comment). Routing
  // it back to "render" stranded an operator with a permanently failed
  // scene: the render screen's own Deliver button was gated on *all*
  // scenes being done, so there was no path forward for clips that had
  // already rendered (and already been paid for) sitting next to one that
  // hadn't. render-progress.tsx's button gate was fixed alongside this.
  complete: "deliver",
  delivered: "deliver",
};

/**
 * The single place that turns a project's scenes into a `ProjectStatus`
 * (docs/architecture.md § "Derived status"). Every reader — the projects
 * list, actions/guard.ts's requireProject, anything added later — must go
 * through this instead of trusting the `projects.status` column, which is
 * what actually drifted (a project's scenes can all finish rendering and
 * the column just sits on 'rendering' forever, since nothing ever writes
 * 'complete' to it — see 0018_derived_project_status.sql).
 *
 * `delivered` is the one exception, and deliberately: it is a human act
 * (actions/deliver.ts markDelivered), not an inference from scene rows —
 * no combination of scene statuses means "an operator clicked Mark
 * delivered". So `storedStatus` is still read here, but only ever checked
 * for that one value; every other value it might hold (an approveBrief or
 * enqueueRender write from before this fix, or any future write to the
 * column) is ignored in favour of recomputing from `scenes`.
 *
 * Priority mostly mirrors 0001_init.sql's original column comment (kept
 * near-verbatim in 0018_derived_project_status.sql's column comment too):
 *
 *   complete  = no scenes in (queued, rendering)
 *   rendering = any scene queued or rendering
 *   framed    = all scenes have ref_frame_asset_id
 *
 * with 'complete' requiring that rendering has actually started (otherwise
 * a fresh, unframed project with zero scenes touched would also read as
 * "no scenes queued/rendering" and incorrectly show complete) and 'draft'
 * covering the one case scene rows can't speak to at all: no scenes yet.
 *
 * One deliberate departure from both migrations' literal wording: 'complete'
 * requires EVERY scene to have left draft/frame_ready, not just "at least
 * one". Both migration comments were written assuming a project's scenes
 * move through the pipeline together, which was already false the moment a
 * scene could be queued individually ("test scene 1 only" leaves its
 * siblings at frame_ready while it finishes) and is now provably false with
 * unfreezeScene (actions/brief.ts), which puts a single previously-'done'
 * scene back to 'frame_ready' for a prompt correction while its siblings
 * stay 'done'. The old "some" check read that exact mix — one
 * mid-correction 'frame_ready' scene next to 'done' siblings — as
 * 'complete' and routed straight to /deliver, while the scene's clip and
 * the project's 'final' asset had just been deleted out from under it. This
 * also keeps deriveProjectStatus in agreement with
 * worker/internal/store/store.go's ProjectsReadyToAssemble, which the same
 * fix requires every scene to be terminal (done/failed) before Go will
 * build a 'final' — Go and TypeScript disagreeing about whether a project
 * is finished is exactly how a delivered video ships silently short.
 *
 * A project with some 'failed' scenes and nothing currently in flight
 * still reads as 'complete' on purpose — the batch has finished running,
 * whether or not every clip in it succeeded. retryScene puts a failed
 * scene back to 'queued', which flips this project straight back to
 * 'rendering' next time it's derived — no project-row write required, and
 * the exact kind of self-healing a stored-and-forgotten column can't do.
 */
export function deriveProjectStatus(
  storedStatus: ProjectStatus,
  scenes: readonly { status: SceneStatus; ref_frame_asset_id: string | null }[],
): ProjectStatus {
  if (storedStatus === "delivered") return "delivered";

  if (scenes.length === 0) return "draft";
  if (scenes.some((scene) => scene.status === "queued" || scene.status === "rendering")) {
    return "rendering";
  }
  if (scenes.every((scene) => !isEditable(scene.status))) return "complete";
  if (scenes.every((scene) => scene.ref_frame_asset_id !== null)) return "framed";
  return "briefed";
}

/**
 * Which pipeline steps a project has EVER reached — the answer step-rail.tsx
 * actually needs, and a different question from deriveProjectStatus's
 * "what is the current step" above.
 *
 * REGRESSION THIS EXISTS TO CLOSE: the `some` → `every` fix to
 * deriveProjectStatus's 'complete' check (see its doc comment) was correct
 * on its own, but nothing downstream accounted for what it implies: a
 * project's derived status can now legitimately move BACKWARDS relative to
 * steps it has already reached and paid for. unfreezeScene
 * (actions/brief.ts) moves one previously-'done' scene back to
 * 'frame_ready' without touching its siblings or ref_frame_asset_id, which
 * derives straight to 'framed' — exactly `[frame_ready, done, done]`. And
 * addScene (actions/brief.ts) has no project-wide editability gate by
 * design, so a brand-new 'draft' scene can land in a project that already
 * has a 'done' sibling — `[draft, done]`, deriving to 'briefed'. Both used
 * to read as "index <= currentIndex" failures once step-rail.tsx compared
 * STATUS_ROUTE positions: a strictly-forward model that assumes status only
 * ever advances. It greyed out Render and Deliver — including clips that
 * had already rendered and already been paid for — with no other in-app way
 * back to them, since /render has no status guard of its own (its gate is
 * derived straight from scenes, not project.status). See
 * lib/project-status.test.ts and components/step-rail.tsx for where this is
 * pinned.
 *
 * Two kinds of evidence feed this, combined with OR — either is sufficient,
 * neither is necessary on its own:
 *
 * 1. storedStatus — the raw `projects.status` column, read BEFORE
 *    deriveProjectStatus overwrites it (that overwrite is exactly why the
 *    column is the wrong signal for CURRENT status — see that function's
 *    doc comment). It is written forward-only, by exactly four call sites
 *    (actions/compile.ts → 'briefed', actions/brief.ts's approveBrief →
 *    'framed', actions/enqueue.ts's enqueueRender/enqueueTestScene/
 *    retryAllFailed → 'rendering', actions/deliver.ts's markDelivered →
 *    'delivered'), and none of them — nor unfreezeScene, nor retryScene,
 *    nor addScene — ever write it backwards or clear it. The exact
 *    staleness that makes it wrong for "current status" is what makes it
 *    reliable for "ever reached".
 * 2. Scene-level facts, for the gaps storedStatus's coarse four-value
 *    ladder can't cover on its own: approveBrief writes 'framed' without
 *    touching a single scene (frame generation is a separate step, kicked
 *    off from the Frames page itself), so storedStatus can momentarily lag
 *    one step behind a frame that has actually generated; and 'complete' is
 *    never written to the column at all (see deriveProjectStatus's doc
 *    comment), so Deliver's reachability can only ever come from scene
 *    evidence or the sticky 'delivered' value.
 */
export interface ReachedSteps {
  character: boolean;
  brief: boolean;
  frames: boolean;
  render: boolean;
  deliver: boolean;
}

const FRAMES_REACHED_STORED_STATUSES: ReadonlySet<ProjectStatus> = new Set([
  "framed",
  "rendering",
  "complete",
  "delivered",
]);

const RENDER_REACHED_STORED_STATUSES: ReadonlySet<ProjectStatus> = new Set([
  "rendering",
  "complete",
  "delivered",
]);

export function deriveReachedSteps(
  storedStatus: ProjectStatus,
  scenes: readonly { status: SceneStatus; ref_frame_asset_id: string | null }[],
): ReachedSteps {
  return {
    // The pipeline's first step — every project starts here.
    character: true,
    // Same evidence deriveProjectStatus uses for 'draft': a project without
    // scenes has nothing to review on the Brief screen yet.
    brief: scenes.length > 0,
    frames:
      FRAMES_REACHED_STORED_STATUSES.has(storedStatus) ||
      scenes.some((scene) => scene.ref_frame_asset_id !== null),
    render:
      RENDER_REACHED_STORED_STATUSES.has(storedStatus) ||
      scenes.some((scene) => !isEditable(scene.status)),
    // Any scene that finished rendering is a clip already paid for and
    // waiting on Deliver — deliver/page.tsx is built to show a partial
    // batch (its "incomplete" banner links back to /render for what's still
    // in flight), so this doesn't wait for every scene to finish.
    // storedStatus === 'delivered' additionally keeps a delivered project's
    // Deliver tab reachable even if a 'done' scene were later unfrozen for
    // correction — delivery is sticky by design (see deriveProjectStatus's
    // doc comment on 'delivered').
    deliver: scenes.some((scene) => scene.status === "done") || storedStatus === "delivered",
  };
}

// The pipeline's fixed order + display label, in one place — moved out of
// components/step-rail.tsx (a Client Component) so a Server Component can
// read the same list without pulling that component's "use client" module
// in. Plain data, no
// JSX: `route` doubles as the key into ReachedSteps, so this array and that
// type can't silently drift apart — TypeScript rejects a route here that
// isn't one of ReachedSteps' keys, same guarantee step-rail.tsx's old local
// copy had.
export const PIPELINE_STEPS: readonly { route: keyof ReachedSteps; label: string }[] = [
  { route: "character", label: "Character" },
  { route: "brief", label: "Brief" },
  { route: "frames", label: "Frames" },
  { route: "render", label: "Render" },
  { route: "deliver", label: "Deliver" },
];
