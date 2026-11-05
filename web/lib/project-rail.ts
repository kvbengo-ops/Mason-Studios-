import type { SceneStatus } from "@/types/db";
import type { ReachedSteps } from "@/lib/project-status";
import type { RailEntry, RailEntryStatus, RailGroup, RailModel } from "@/lib/project-rail-types";

// Pure derivation half of the vertical project rail — see lib/project-
// rail-types.ts's header for the split this file is one side of. No I/O:
// everything it needs is passed in, already fetched, by
// app/(app)/projects/[id]/layout.tsx. That mirrors lib/project-status.ts's
// own split (derive from plain data, let the caller do the fetching), which
// is what keeps this unit-testable without a database.

/**
 * Minimal scene shape buildRailModel needs — a Pick of the scenes row, not
 * the whole Row, so callers (and tests) don't have to fabricate columns
 * nothing here reads.
 */
export interface RailSceneInput {
  id: string;
  idx: number;
  is_talking_head: boolean;
  status: SceneStatus;
  duration_s: number;
  /**
   * When the worker claimed this scene (worker/internal/store/store.go's
   * ClaimQueuedScenes), or null if it hasn't been claimed. The origin for
   * the running row's elapsed clock — see buildSceneEntry.
   */
  submitted_at: string | null;
}

/** Minimal project shape buildRailModel needs — see each field's use below. */
export interface RailProjectInput {
  id: string;
  title: string;
  character_desc: string | null;
  product_name: string | null;
  script_raw: string | null;
  render_settings: unknown;
}

export interface BuildRailModelArgs {
  project: RailProjectInput;
  scenes: readonly RailSceneInput[];
  /**
   * From lib/project-status.ts's deriveReachedSteps, computed once in
   * actions/guard.ts's requireProject/requireProjectReadable and threaded
   * down through layout.tsx — NOT re-derived here. That function's own doc
   * comment is the reason: `project.status` can legitimately move
   * backwards (a reopened scene via unfreezeScene, or a scene added after
   * rendering already started) while clips already rendered — already paid
   * for — stay exactly as reachable as before. Recomputing reachability
   * from status in a second place is exactly the "second copy of a
   * derivation" failure mode this codebase has scar tissue over (see that
   * file's STATUS_ROUTE comment) — so this function only ever reads
   * `reached`, never `project.status`.
   */
  reached: ReachedSteps;
  /**
   * Whether an `assets` row of kind 'final' exists for this project. Half of
   * the only in-flight signal the rail can read straight from the database —
   * see the cut group in buildRailModel.
   */
  hasFinalAsset: boolean;
  /**
   * Whether this viewer may add a scene — `isOwner` from
   * requireProjectReadable. An admin reading someone else's project gets the
   * rail without the add row, matching actions/brief.ts's addScene, which
   * goes through requireProject and would refuse them.
   */
  canAddScene: boolean;
  /** getKieAccountBalanceUsd()'s result — null means "could not be read", not zero. */
  /**
   * What this project has already been billed, summed from `runs` — actual
   * spend, not an estimate of what a re-render would cost. See buildSubtitle
   * for why it belongs in the rail rather than only on the pages that spend.
   */
  spentUsd: number;
}

// Same figure as lib/spend.ts's DAILY_CAP_USD default. Not imported from
// there: lib/spend.ts pulls in @/lib/supabase/server (createAdminClient),
// which would drag a server-only module into this file's "no I/O" contract
// and force every test of this file to mock Supabase for a constant it
// never queries. A balance under one editor's daily cap is low enough that
// a single busy day could run the account dry, which is the same reasoning
// DAILY_CAP_USD's own $5 default rests on.

// Setup is a hard gate (see this file's buildRailModel doc comment): until
// a script has compiled into scenes, both downstream groups are dimmed and
// every entry in them locked.
//
// The sentence is said ONCE, on the Scenes row — the group the gate actually
// belongs to — and it IS that row's text, not a second line under a label
// (RailEntry.lockedReason). Cut's locked row keeps its own name instead of
// echoing this two rows below it, which is what the earlier "reason under
// the label" shape produced: two groups, four lines, one fact.
//
// Short enough to fit that one line at this rail's 13rem, which is the
// constraint that beat the previous two attempts — "Compile a script into
// scenes" clipped to "Compile a script into s...", and "Compile the script
// first" needed a second line to say the same thing "Compile the script"
// already says.
const SCRIPT_NOT_COMPILED_REASON = "Compile the script";

/**
 * The ids buildRailModel mints for the Setup rows, named so a screen can
 * point its in-flight state at its own rail row without hardcoding a string
 * that only this file decides.
 *
 * The design's rule is that every API call owns a rail entry which spins
 * while the call runs — and unlike a scene render (queued/rendering, on the
 * row, readable by any server render), the four setup calls are awaited
 * inline inside their own server action. Nothing about them is ever visible
 * to a server render: by the time the rail is rebuilt, the call it would have
 * been spinning for has already returned. That work is therefore reported at
 * runtime, from the client that fired it, via useRailBusyWhile
 * (components/project-rail.tsx) — these are the ids to hand it.
 */
export const RAIL_ENTRY_CHARACTER = "setup-character";
export const RAIL_ENTRY_PRODUCT = "setup-product";
export const RAIL_ENTRY_SCRIPT = "setup-script";
export const RAIL_ENTRY_RENDER_SETTINGS = "setup-render-settings";

function projectRoute(projectId: string, path: string): string {
  return `/projects/${projectId}/${path}`;
}

/**
 * The line under the project title: scenes, runtime, and what this project
 * has ACTUALLY cost so far.
 *
 * The money is the part the design insists on ("2 scenes · 12s · $4.17"),
 * and its argument is about where the number lives rather than whether it
 * exists: the rail is the one thing on screen from every route, so a running
 * total here is the only spend figure an operator sees without going to look
 * for it. Everywhere else it is a number you have to navigate to, by which
 * point you have usually already decided to spend more.
 *
 * Actual, not estimated — summed from `runs`, so it is what was billed and
 * not what a re-render would cost. Omitted entirely at zero rather than
 * shown as "$0.00": a project that has spent nothing has nothing to report,
 * and a zero sitting in the chrome reads like a broken number.
 */
function buildSubtitle(scenes: readonly RailSceneInput[], spentUsd: number): string {
  const money = spentUsd > 0 ? ` · ${usdFormatter.format(spentUsd)}` : "";
  if (scenes.length === 0) return `No scenes yet${money}`;
  const totalDurationS = scenes.reduce((sum, scene) => sum + scene.duration_s, 0);
  return `${scenes.length} scene${scenes.length === 1 ? "" : "s"} · ${totalDurationS}s${money}`;
}

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
});

/** Maps a scene's own status onto the five states components/status-icon.tsx draws — see RailEntryStatus's doc comment for why this is a closed, reused vocabulary, not a new one. */
function sceneEntryStatus(status: SceneStatus): RailEntryStatus {
  if (status === "done") return "done";
  if (status === "failed") return "failed";
  // queued is its OWN state, not a shade of running. Collapsing the two
  // gave a scene the worker had not claimed yet a spinning glyph whose
  // accessible name said "Rendering" beside its own trailing word "queued" —
  // the row contradicting itself, and saying the wrong one to a screen
  // reader. It also has no submitted_at, so it has no clock to show, which
  // is exactly the difference the two words exist to carry.
  if (status === "queued") return "queued";
  if (status === "rendering") return "running";
  // draft, frame_ready
  return "idle";
}

function sceneStateWord(status: SceneStatus): string {
  switch (status) {
    case "draft":
      return "draft";
    case "frame_ready":
      return "frame ready";
    case "queued":
      return "queued";
    case "rendering":
      return "rendering";
    case "done":
      return "done";
    case "failed":
      return "failed";
  }
}

/**
 * The two statuses that mean the worker owns this scene right now, and so the
 * only two the elapsed clock has anything to measure — same set
 * lib/render-elapsed.ts scopes its own origin to, for the same reason.
 */
function sceneIsInFlight(status: SceneStatus): boolean {
  return status === "queued" || status === "rendering";
}

function buildSceneEntry(projectId: string, scene: RailSceneInput): RailEntry {
  return {
    id: scene.id,
    label: `${scene.idx + 1} · ${scene.is_talking_head ? "A-roll" : "B-roll"}`,
    status: sceneEntryStatus(scene.status),
    // A running row's trailing text is a clock, not a word. "rendering" is
    // the same string at four seconds and at eight minutes, which is exactly
    // how a render that had already finished and already billed sat reading
    // "rendering" while nothing said anything was wrong. The word below stays
    // as the fallback: it is what the server renders, what a still-queued
    // scene (no submitted_at to measure from) keeps, and what every terminal
    // row shows.
    elapsedSince: sceneIsInFlight(scene.status) ? scene.submitted_at : null,
    // Its own page — /projects/<id>/scenes/<sceneId>, the workbench that
    // holds this scene's frame, prompt and clip together.
    //
    // This replaced a fragment onto whichever of frames/brief/render matched
    // the scene's status, which was an interim: every scene in a given state
    // shared one route, so all but the first rail row navigated to the page
    // the operator was already standing on and looked dead.
    //
    // `reached` no longer gates it either. The workbench exists for a scene in
    // any state, including a draft with nothing rendered, and says so on the
    // page rather than being unreachable. `reached` still governs the Cut
    // group below, which is where that rule genuinely belongs.
    href: `/projects/${projectId}/scenes/${scene.id}`,
    count: sceneStateWord(scene.status),
  };
}

/**
 * Turns a project, its scenes, and the two vendor balances into a
 * `RailModel` — the pure derivation half of the rail (see this file's
 * header). No I/O; the caller (layout.tsx) does the fetching.
 *
 * ## The three groups
 *
 * **setup** — Character, Product, Script, Render settings, each its own
 * route now (/character, /product, /script, /settings) — they used to
 * share one page (/character alone), which is why currentEntryId
 * (components/project-rail.tsx) once needed a first-match tie-break; with
 * four distinct hrefs there are no ties left to break. /brief exists but
 * only ever reviews already-compiled scenes (components/scene-table.tsx) —
 * nothing on it is part of setup. Group `count` is "n/4" while any of the
 * four is still empty and nothing at all once they are all filled (see
 * RailGroup.count), "done" meaning each field has ever been filled in
 * (character_desc/product_name/script_raw non-empty, render_settings
 * non-null) — an informational tally, not a gate; the real gate for
 * downstream groups is `scenes.length`, below.
 *
 * **scenes** — one entry per scene, ordered by idx, "{idx+1} · A-roll" /
 * "B-roll" from is_talking_head. Status maps from the scene's own status
 * (done/failed passthrough, queued/rendering -> running, else idle); href
 * points at that scene's own workbench, /projects/<id>/scenes/<sceneId>.
 *
 * It used to point at whichever of brief/frames/render owned the scene's
 * status, gated through `reached`. Both went when the workbench landed: every
 * scene in one state shared a route, so all but the first rail row navigated
 * to the page the operator already stood on, and the workbench is reachable
 * whatever state its scene is in. `reached` still gates the cut below — see
 * BuildRailModelArgs.reached's doc comment.
 *
 * **cut** — one "Final video" entry -> the existing /deliver route,
 * `count` "{done}/{total}".
 *
 * ## Gating
 *
 * Setup is a HARD gate: while `scenes.length === 0` (the script hasn't
 * compiled yet), both scenes and cut render as a single locked placeholder
 * entry each, dimmed, naming SCRIPT_NOT_COMPILED_REASON — never hidden, so
 * the operator can see the shape of the work while still filling setup in.
 *
 * Cut is a SOFT gate once scenes exist: Final video's `status` is never
 * "locked" past that point (only "idle" or "done") — an incomplete batch
 * (1/2 done) still needs to be watchable, not blocked. Its `href` still
 * follows `reached.deliver` (some scene done, or the project has been
 * delivered) rather than being unconditionally set the moment scenes
 * exist, so it never promises a route the rest of the app doesn't actually
 * open yet.
 */
export function buildRailModel(args: BuildRailModelArgs): RailModel {
  const { project, scenes, reached, spentUsd, hasFinalAsset, canAddScene } = args;

  // Four distinct routes now — see this function's own doc comment above.
  const setupItems: {
    id: string;
    label: string;
    done: boolean;
    href: string;
    icon?: RailEntry["icon"];
  }[] = [
    {
      id: RAIL_ENTRY_CHARACTER,
      label: "Character",
      done: Boolean(project.character_desc?.trim()),
      href: projectRoute(project.id, "character"),
    },
    {
      id: RAIL_ENTRY_PRODUCT,
      label: "Product",
      done: Boolean(project.product_name?.trim()),
      href: projectRoute(project.id, "product"),
    },
    {
      id: RAIL_ENTRY_SCRIPT,
      label: "Script",
      // Ticked by COMPILING, not by saving text. The rail used to say
      // "Script ✓" the moment a script was saved while the Scenes group
      // directly beneath it still read "Compile the script" — telling the
      // operator in two adjacent rows that the step was finished and that
      // they had not done it yet.
      //
      // Scenes are what this step produces, so their existence is what
      // completes it. Saving is progress; compiling is completion. This also
      // makes the Setup count honest: 3/3 now means the project can actually
      // move, which is the question the count is there to answer.
      done: scenes.length > 0,
      href: projectRoute(project.id, "script"),
    },
    // No "Render settings" row, on the second and final pass at this.
    //
    // The first removal was wrong and had to be reverted: the settings had
    // no other route, so deleting the row orphaned the screen. That is no
    // longer true. Shooting Mode, Direction and Captions render in the scene
    // page's own column, and the model/length/resolution that used to be
    // the point of this step are now the Scene Settings panel, per scene,
    // which is where the decision actually gets made.
    //
    // /settings still exists and still holds the project-wide render
    // defaults — what a NEW scene inherits, and the per-30s-ad estimate,
    // neither of which any single scene can show. It is reached from a link
    // in that same column (components/scene-settings-panel.tsx) rather than
    // from a Setup step, because it is no longer part of setting a project
    // up: you can render every scene without ever opening it.
  ];
  const setupDoneCount = setupItems.filter((item) => item.done).length;

  const setupGroup: RailGroup = {
    id: "setup",
    label: "Setup",
    // Only while there is something left to do — see RailGroup.count. A
    // permanent "3/3" is furniture, and it was the only thing marking Setup
    // as unfinished when it wasn't.
    count:
      setupDoneCount === setupItems.length ? undefined : `${setupDoneCount}/${setupItems.length}`,
    entries: setupItems.map((item) => ({
      id: item.id,
      label: item.label,
      href: item.href,
      status: item.done ? "done" : "idle",
      icon: item.icon,
    })),
  };

  const hasScenes = scenes.length > 0;
  const orderedScenes = [...scenes].sort((a, b) => a.idx - b.idx);

  const scenesGroup: RailGroup = hasScenes
    ? {
        id: "scenes",
        label: "Scenes",
        entries: orderedScenes.map((scene) => buildSceneEntry(project.id, scene)),
        // Appends after the last scene, matching where the brief table's own
        // trailing Add button inserts. Omitted for a non-owner, whose click
        // addScene's requireProject would refuse anyway.
        addScene: canAddScene
          ? { projectId: project.id, afterIdx: orderedScenes[orderedScenes.length - 1]!.idx }
          : undefined,
      }
    : {
        id: "scenes",
        label: "Scenes",
        dimmed: true,
        entries: [
          {
            id: "scenes-locked",
            label: "Scenes",
            status: "locked",
            href: null,
            // The gate belongs to THIS group, so this is the row that says it
            // — and the sentence replaces the label rather than sitting under
            // it, since the "SCENES" heading directly above already named the
            // row. See SCRIPT_NOT_COMPILED_REASON.
            lockedReason: SCRIPT_NOT_COMPILED_REASON,
          },
        ],
      };

  const doneCount = scenes.filter((scene) => scene.status === "done").length;
  const totalCount = scenes.length;

  // Exactly the worker's own ProjectsReadyToAssemble predicate
  // (worker/internal/store/store.go), minus the join: every scene terminal,
  // at least one 'done', and no `final` asset yet. In that window the
  // assemble loop either has the project or will claim it on its next ~30s
  // pass — so this is the one API call in the design's activity table
  // ("final stitch -> Final video") that leaves a trace a server render can
  // actually see, and the rail can spin honestly without anyone telling it
  // to. It is the same state the Deliver page already reports as
  // "assembling…" (components/assembling-status.tsx polls hasFinalAsset for
  // it), so the rail agrees with the page rather than inventing a status.
  const assembling =
    totalCount > 0 &&
    doneCount > 0 &&
    scenes.every((scene) => scene.status === "done" || scene.status === "failed") &&
    !hasFinalAsset;

  const cutGroup: RailGroup = hasScenes
    ? {
        id: "cut",
        label: "Cut",
        entries: [
          {
            id: "cut-final",
            label: "Final video",
            // Soft gate: never "locked" once scenes exist, even at 0 done —
            // see this function's doc comment.
            status: doneCount === totalCount ? "done" : "idle",
            href: reached.deliver ? projectRoute(project.id, "deliver") : null,
            count: `${doneCount}/${totalCount}`,
            busy: assembling,
          },
        ],
      }
    : {
        id: "cut",
        label: "Cut",
        dimmed: true,
        entries: [
          {
            id: "cut-locked",
            label: "Final video",
            status: "locked",
            href: null,
            // No lockedReason on purpose. Cut is locked by the same gate the
            // Scenes row two lines above already names; repeating the
            // sentence here is what made a locked rail four lines that said
            // one thing. See SCRIPT_NOT_COMPILED_REASON.
          },
        ],
      };

  return {
    projectId: project.id,
    projectTitle: project.title,
    // canAddScene IS isOwner (see its doc comment above) — the same viewer
    // test the rename needs. Derived from it rather than taking a second
    // ownership flag, so the two can never be passed different answers.
    readOnly: !canAddScene,
    projectSubtitle: buildSubtitle(scenes, spentUsd),
    groups: [setupGroup, scenesGroup, cutGroup],
    backHref: "/projects",
  };
}
