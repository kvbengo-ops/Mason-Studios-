// Pure checks for the Render gate (docs/architecture.md § "User flow" step
// 7). Pulled out of actions/enqueue.ts — a "use server" file, where every
// export must be an async Server Action — so these stay plain, synchronous,
// unit-testable functions, mirroring lib/recompile-guard.ts.

import type { SceneStatus } from "@/types/db";
import { isEditable } from "@/lib/editable-guard";
import {
  isFpsAllowedForDuration,
  isResolutionAllowedForDuration,
  maxDurationForFps,
  maxDurationForResolution,
  mergeRenderSettings,
  pickModel,
  type RenderSettings,
  type VideoModelDescriptor,
} from "@/lib/models";

// A scene has money committed against it once it leaves draft/frame_ready.
// 'failed' is included deliberately even though it's a terminal state: a
// failed scene got there via queued -> rendering -> failed, so a run (and
// its cost) already exists for it. Treating it as "not yet spent" would let
// enqueueRender silently re-queue it as part of a fresh batch instead of
// going through the per-scene retryScene path that architecture.md calls
// out by name.
const ALREADY_SPENT_STATUSES: readonly SceneStatus[] = ["queued", "rendering", "done", "failed"];

/**
 * Scenes not yet submitted for render — the set enqueueRender and the
 * render gate should actually act on (docs/architecture.md § "The
 * contract"). Reuses isEditable (lib/editable-guard.ts) rather than a
 * parallel status list: "still editable" and "still awaiting render" are
 * the same boundary — draft/frame_ready — described from two angles. A
 * scene that's already queued/rendering/done/failed has money already
 * committed (or, for 'failed', an attempt already made) and must go
 * through retryScene/rerenderScene instead of being swept back into a
 * fresh enqueue — this is what lets enqueueRender survive a partial
 * (e.g. test-scene) render instead of refusing outright the moment any
 * scene has left draft/frame_ready.
 */
export function scenesAwaitingRender<T extends { status: SceneStatus }>(scenes: readonly T[]): T[] {
  return scenes.filter((scene) => isEditable(scene.status));
}

/**
 * Throws unless every scene in the given list has passed the
 * reference-frame gate. Callers decide the scope — enqueueRender passes
 * only scenesAwaitingRender(...), not the whole project, so a scene that
 * already rendered (and by definition already had a frame) never has to be
 * re-checked here.
 */
export function assertAllFramed(scenes: readonly { ref_frame_asset_id: string | null }[]): void {
  const missing = scenes.filter((scene) => !scene.ref_frame_asset_id);
  if (missing.length > 0) {
    throw new Error(
      `${missing.length} of ${scenes.length} scene(s) do not have a reference frame yet — ` +
        "both gates (Review Brief, Review Frames) must be passed before rendering.",
    );
  }
}

/**
 * Throws if any scene's duration is one that the model IT will actually
 * render on will reject.
 *
 * Resolves a model PER SCENE via lib/models.ts's pickModel — which mirrors
 * worker/internal/kie/models.go's PickModel — rather than validating every
 * scene against the one model project.render_settings.model names. Those
 * used to be the same thing, back when every scene rendered on whatever
 * model the project selected. They stopped being the same thing the moment
 * a project could explicitly select Kling: a talking-head scene on such a
 * project renders on Kling's own allowed-duration set (3-15s), not
 * whichever set an earlier `settings.model` check assumed, so a
 * single project-wide check here would pass a scene that kie then rejects —
 * AFTER submission, which is where the money goes (unlike the template-v1
 * case below, a mixed batch that reaches kie can have some scenes accepted
 * and billed before the rejected one is even reached).
 *
 * actions/brief.ts's splitScene makes this deterministically reachable
 * already: it assigns both halves of a split scene the PROJECT's selected
 * model's shortest allowed duration regardless of is_talking_head, which a
 * differently-constrained model reached via pickModel (Hailuo's {6, 10} set,
 * say) can still reject.
 *
 * Takes settings + audioEnabled (not a single model descriptor) for exactly
 * this reason — as of 0012_render_settings.sql the allowed set is a
 * property of the model, not of the schema — that migration dropped
 * scenes_duration_s_check for exactly this reason, and this guard is one of
 * the three layers named in its comment header that now carry the rule
 * instead; pickModel is what decides, per scene, which model's set applies.
 *
 * The compiler's schema and the Gate 1 editor both constrain this already,
 * but rows compiled under template v1 are still sitting in the database with
 * 2s/3.5s/4s durations, which no current model accepts. Rendering one of
 * those sends the whole batch to kie only to have every scene come back
 * rejected. Neither fal nor kie charges for a validation rejection, so THIS
 * particular case protects minutes rather than dollars — but it fails at
 * the gate, with a message naming the fix, instead of five minutes later in
 * a worker log nobody is watching.
 */
/** One model's worth of scenes whose duration that model will reject. */
export interface UnrenderableDurationGroup {
  model: VideoModelDescriptor;
  /** The distinct offending durations, ascending. */
  durationsS: number[];
  /** How many scenes carry one of them. */
  count: number;
}

/**
 * Finds the scenes whose duration the model they'd route to will reject,
 * grouped by that model. Empty means the batch is renderable.
 *
 * Pure and exported so the render gate can WARN with the same analysis
 * assertRenderableDurations BLOCKS with. Two implementations of "which
 * durations are illegal here" would be free to disagree, and the shape of
 * that disagreement is the worst one available: a gate that shows no warning
 * and then refuses the click.
 *
 * Grouped by model, not a single flat list: a mixed batch can have some
 * scenes routed to Seedance and others to Kling or Hailuo, each rejecting a
 * different duration for a different reason, and the message has to say
 * which is which rather than blaming one model's allowed set for a scene
 * that was never going to render on it.
 *
 * Each scene is resolved against its OWN effective settings — the project's
 * blob merged with scenes.render_settings_override (0045) — not against the
 * `settings` argument alone. That closes a gap this comment used to just
 * name: a scene an earlier retry pinned to a model with a shorter allowed
 * set than the project's (Hailuo stops at 10s where Kling and Seedance both
 * reach 15s) passed the check and was then rejected by kie.
 *
 * The blocking callers in actions/enqueue.ts were already safe, because each
 * hands in settings it had merged itself — enqueueRender per
 * effective-settings group, enqueueTestScene and rerenderScene per scene. The
 * render gate was not: it passes the picker's raw project settings, so the
 * WARNING above the button was blind to an override the guard behind the
 * button would catch. That is the exact shape this function exists to
 * prevent — a gate that shows nothing and then refuses the click. Merging
 * here rather than at each call site is what makes the two agree by
 * construction; for the callers that already merged, merging again with the
 * same override is idempotent.
 */
export function findUnrenderableDurations(
  scenes: readonly {
    duration_s: number;
    is_talking_head: boolean;
    /** 0045's per-scene override; absent/null is the ordinary case. */
    render_settings_override?: unknown;
  }[],
  settings: RenderSettings,
  audioEnabled: boolean,
): UnrenderableDurationGroup[] {
  const badByModel = new Map<
    string,
    { model: VideoModelDescriptor; durations: Set<number>; count: number }
  >();

  for (const scene of scenes) {
    const effective = mergeRenderSettings(settings, scene.render_settings_override ?? null);
    const model = pickModel(scene.is_talking_head, audioEnabled, effective);
    if (!model.allowedDurationsS.includes(scene.duration_s)) {
      const entry = badByModel.get(model.id) ?? { model, durations: new Set<number>(), count: 0 };
      entry.durations.add(scene.duration_s);
      entry.count += 1;
      badByModel.set(model.id, entry);
    }
  }

  return [...badByModel.values()].map(({ model, durations, count }) => ({
    model,
    durationsS: [...durations].sort((a, b) => a - b),
    count,
  }));
}

export function assertRenderableDurations(
  scenes: readonly { duration_s: number; is_talking_head: boolean }[],
  settings: RenderSettings,
  audioEnabled: boolean,
): void {
  const groups = findUnrenderableDurations(scenes, settings, audioEnabled);
  if (groups.length === 0) return;

  const totalBad = groups.reduce((sum, group) => sum + group.count, 0);
  const perModel = groups.map(
    ({ model, durationsS, count }) =>
      `${count} on ${model.label} (${durationsS.join("s, ")}s; allowed ${model.allowedDurationsS.join(", ")} seconds)`,
  );

  throw new Error(
    `${totalBad} of ${scenes.length} scene(s) have a duration their model will reject: ` +
      `${perModel.join("; ")}. Recompile the brief, or adjust the durations on the Review Brief step.`,
  );
}

/**
 * Throws if the project's settings are illegal for any scene's length.
 *
 * Separate from assertRenderableDurations because these are *cross-field*
 * constraints — a value legal on the fps or resolution axis alone can still
 * be illegal in combination with a scene's length (LTX's old "50fps only
 * under 10s" rule and Hailuo's old "no 10s at 1080P" rule were both this
 * shape; both descriptors that carried them are gone, so every current
 * model's maxDurationSByFps/maxDurationSByResolution is empty — see this
 * function's own doc comment on VideoModelDescriptor). Nothing in the
 * render_settings object alone can catch a constraint like this — the
 * durations live on `scenes` — so the render gate is the last place it can
 * be caught before kie rejects the whole batch.
 *
 * Two axes, checked together deliberately: adding a second exported assert
 * per axis would mean every call site has to remember to call both, and the
 * one that forgot would submit and pay for a batch kie rejects. One
 * function, one call, both rules — currently both vacuous, both still
 * enforced the moment a model reintroduces either constraint.
 *
 * The rules themselves are data on the descriptor (maxDurationSByFps and
 * maxDurationSByResolution), so a model that adds a limit on either axis is
 * covered without touching this function.
 */
export function assertSettingsAllowedForDurations(
  scenes: readonly { duration_s: number }[],
  model: VideoModelDescriptor,
  settings: RenderSettings,
): void {
  const offending = scenes.filter(
    (scene) => !isFpsAllowedForDuration(model, settings.fps, scene.duration_s),
  );
  if (offending.length > 0) {
    const max = maxDurationForFps(model, settings.fps);
    const longest = Math.max(...offending.map((scene) => scene.duration_s));
    throw new Error(
      `${settings.fps} fps is only valid for clips of ${max}s or shorter on ${model.label}, ` +
        `but ${offending.length} of ${scenes.length} scene(s) are longer (up to ${longest}s). ` +
        "Lower the frame rate on the Render step, or shorten those scenes.",
    );
  }

  // fps first, then resolution, and only ever one thrown. A batch violating
  // both gets fixed one message at a time, which is worse than naming both
  // at once — but assertRenderableDurations and every other guard in this
  // file throw on first offence, and a guard that sometimes reports two
  // problems and sometimes one is harder to test than one that always
  // reports the first. renderSettingsSchemaFor, which can collect issues, is
  // where both are surfaced together.
  const offendingResolution = scenes.filter(
    (scene) => !isResolutionAllowedForDuration(model, settings.resolution, scene.duration_s),
  );
  if (offendingResolution.length > 0) {
    const max = maxDurationForResolution(model, settings.resolution);
    const longest = Math.max(...offendingResolution.map((scene) => scene.duration_s));
    throw new Error(
      `${model.label} only accepts ${settings.resolution} for clips of ${max}s or shorter, ` +
        `but ${offendingResolution.length} of ${scenes.length} scene(s) are longer (up to ${longest}s). ` +
        "Lower the resolution on the Render step, or shorten those scenes.",
    );
  }
}

/**
 * Throws unless a scene is eligible for rerenderScene (actions/enqueue.ts).
 *
 * 'queued'/'rendering' get a distinct message from every other non-'done'
 * status: those two mean a render is already in flight for this scene, so
 * re-queuing it now would submit a second paid job against the same clip,
 * not just be a no-op click. Everything else (draft/frame_ready/failed) is
 * routed to a different action already — retryScene owns 'failed', and a
 * scene that hasn't rendered yet has nothing to re-render.
 */
export function assertSceneRerenderable(status: SceneStatus): void {
  if (status === "queued" || status === "rendering") {
    throw new Error(
      `Scene is "${status}" — a render is already in flight for it. Re-queuing it now would ` +
        "submit a second paid job for the same clip. Wait for the current attempt to finish.",
    );
  }
  if (status !== "done") {
    throw new Error(
      `Scene is "${status}", not "done" — rerenderScene only applies to scenes that have already ` +
        "finished rendering. Use retryScene for a failed scene, or enqueueRender to start the batch.",
    );
  }
}

/**
 * Throws if any scene in the given list has already progressed past
 * draft/frame_ready. enqueueRender calls this against
 * scenesAwaitingRender(scenes), where it's a belt-and-braces check (that
 * filter already excludes anything spent) rather than the whole-project
 * gate it used to be; enqueueTestScene calls it against a single scene,
 * where it's the real guard against double-submitting that scene.
 */
export function assertNotAlreadySpent(scenes: readonly { status: SceneStatus }[]): void {
  const spent = scenes.filter((scene) => ALREADY_SPENT_STATUSES.includes(scene.status));
  if (spent.length > 0) {
    throw new Error(
      `This project already has ${spent.length} scene(s) past draft/frame_ready — rendering ` +
        "has already been enqueued once and cannot be enqueued again. Use retryScene for " +
        "individual failed clips.",
    );
  }
}
