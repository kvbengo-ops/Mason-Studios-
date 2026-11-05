// Pure render-cost estimation, split out of lib/claude.ts so it can be
// imported by Client Components without dragging the rest of that file's
// server-only half along with it — same reasoning as lib/render-budget.ts's
// split from render-confirm-dialog.tsx. Before this split, importing
// estimateCost from lib/claude.ts pulled in `@anthropic-ai/sdk` and the
// Brief zod schema too, since ES modules can't be partially loaded: every
// name a file exports, reachable or not, drags that file's top-level
// imports into any bundle that imports the file at all. lib/claude.ts now
// carries `import "server-only"` specifically so this can't regress
// silently — a Client Component that reaches for estimateCost via
// "@/lib/claude" again will fail the build instead of quietly shipping the
// SDK to the browser.
//
// Nothing here may import `@anthropic-ai/sdk`, zod, or anything else
// server-only. `./models` is safe to depend on — it already ships to the
// client directly (see components/render-gate.tsx) since the render gate
// needs VIDEO_MODELS/getModel/priceForSecond to build its own UI.

import {
  billingResolution,
  clipCostUsd,
  getModel,
  mergeRenderSettings,
  pickModel,
  priceForSecond,
  pricingAudioOn,
  type RenderSettings,
} from "./models";

export interface CostEstimate {
  totalUsd: number;
  talkingHeadCount: number;
  silentCount: number;
  seconds: number;
  /**
   * Whether this estimate was computed with AUDIO_ENABLED=1. Carried on the
   * result (not just consumed internally) so callers rendering the
   * breakdown text can tell the operator every scene is silent — and why
   * the price is lower than talkingHeadCount would otherwise imply —
   * instead of reporting a "N talking-head + M silent" split that no
   * longer matches what gets billed.
   */
  audioEnabled: boolean;
  /**
   * The resolution this estimate was priced at, and the per-second silent
   * rate that resolution costs. Carried on the result so the render gate can
   * show *why* the number moved when the operator changes resolution —
   * "$0.08/s at 1440p" is the difference between a price the operator trusts
   * and a number that jumped for no visible reason.
   */
  resolution: string;
  silentPerSecondUsd: number;
}

/**
 * Loosened counterpart of lib/claude.ts's `Brief` for cost estimation:
 * identical shape, but duration_s is plain `number` rather than the
 * descriptor-derived literal union. See estimateCost's doc comment for why
 * the two types must diverge — in short, Brief is a generation-time
 * contract enforced against the compiler's structured output, while
 * estimation runs against whatever duration_s a `scenes` row actually has,
 * conforming or not. Deliberately declared standalone here, rather than
 * derived from Brief via Omit/mapped types, so this module never needs to
 * import lib/claude.ts (and its zod/Anthropic imports) just for a type.
 */
export interface EstimatableBrief {
  character: string;
  scenes: {
    script_line: string;
    video_prompt: string;
    is_talking_head: boolean;
    duration_s: number;
    /**
     * Every video reference (scene_references.kind = 'video') this scene
     * carries, as that asset's OWN duration in seconds — never this scene's
     * duration_s, which is the OUTPUT length and prices separately. Absent
     * or empty for the overwhelming majority of scenes, which carry no
     * video reference at all, and estimateCost below must price those
     * identically to before this field existed.
     *
     * A `null` ENTRY, not an absent one, is how an unmeasured upload is
     * spelled here — assets.duration_s came back null because the
     * operator's browser could not decode that file's metadata
     * (components/ugc-reference-picker.tsx's videoDurationSeconds returns
     * null in exactly that case, same discipline as the audio equivalent it
     * was copied from). estimateCost turns that into an unbounded
     * over-quote rather than guessing a number — see its own comment.
     */
    videoReferenceDurationsS?: readonly (number | null)[];
  }[];
}

/**
 * audioEnabled is required, not defaulted from isAudioEnabled() here,
 * because this function is also called from client components (e.g.
 * CostBadge via SceneTable) where process.env.AUDIO_ENABLED — a
 * deliberately non-NEXT_PUBLIC_ var — reads as undefined. Every call site
 * must read the flag once server-side (isAudioEnabled(), in models.ts) and
 * pass it down explicitly, so the estimate always reflects the real
 * server-side setting instead of silently defaulting to "off" on the client.
 *
 * `settings` is required for the same reason and a sharper one: the silent
 * rate is per-resolution ($0.04/s at 1080p, $0.08 at 1440p, $0.16 at 2160p),
 * so an omitted-and-defaulted argument would quietly quote the 1080p price
 * for a 2160p render and understate the bill by 4x. Every caller — the Brief
 * badge, the render gate card, the confirm dialog, enqueueRender's
 * pre-flight cap check — passes the project's own settings, so all four
 * agree on the number and the daily-cap check enforces the price the
 * operator was actually shown. It is deliberately not optional; a default
 * here is a silent wrong answer.
 *
 * Takes EstimatableBrief, not Brief, deliberately: Brief.scenes[].duration_s
 * is a strict literal union drawn from the model descriptor because that
 * type feeds zodOutputFormat() and must steer/validate what the compiler
 * generates. estimateCost's callers build their input from real `scenes`
 * table rows, including ones compiled under prompt_templates v1 before this
 * constraint existed — those legitimately have non-allowed durations (e.g.
 * 4s) sitting in the DB. The estimate must reflect what will actually be
 * billed for a row regardless of whether that row conforms, so it accepts
 * plain `number` here rather than reusing the compiler's stricter output
 * type.
 */
export function estimateCost(
  brief: EstimatableBrief,
  audioEnabled: boolean,
  settings: RenderSettings,
): CostEstimate {
  const silentModel = getModel(settings.model);
  const silentPerSecondUsd = priceForSecond(silentModel, settings.resolution);

  let talkingHeadCount = 0;
  let silentCount = 0;
  let seconds = 0;
  let totalUsd = 0;

  for (const scene of brief.scenes) {
    seconds += scene.duration_s;
    if (scene.is_talking_head) {
      talkingHeadCount += 1;
    } else {
      silentCount += 1;
    }
    // Bills on the *effective* routing decision, not is_talking_head alone
    // — routed through pickModel() (below in ./models), not reimplemented
    // here, so this can never drift from it. lib/enqueue-guard.ts's
    // assertRenderableDurations already calls pickModel for exactly this
    // reason (validate against the model that will actually render a scene,
    // not the one is_talking_head alone implies) — this is the same
    // decision, just priced instead of validated, so it goes through the
    // same function rather than a second hand-copied rule. talkingHeadCount/
    // silentCount above still reflect the script's real is_talking_head
    // values (informational — that flag is never rewritten), but totalUsd
    // must reflect what will actually be charged, or the gate quotes a
    // price the worker won't charge.
    const billedModel = pickModel(scene.is_talking_head, audioEnabled, settings);
    // clipCostUsd, not a rate multiplied by a duration here. priceForSecond
    // is audio-aware, so a call site that builds the product itself has to
    // agree with every other call site about the audio flag; see
    // clipCostUsd's own doc comment.
    //
    // settings.resolution WHEN billedModel actually lists it, else its own
    // default — billingResolution, same shape as the worker's
    // standardModel. This used to force Kling straight to its
    // defaultResolution unconditionally, which was harmless while Kling had
    // exactly one tier and would have gone silently wrong the moment it got
    // a second: a /ugc project saved at std/720p would have priced, and
    // rendered, at pro/1080p — caught in review, never shipped. See
    // billingResolution's own doc comment.
    const resolution = billingResolution(billedModel, settings.resolution);
    // SUM OF EVERY ATTACHED VIDEO REFERENCE'S OWN DURATION, in seconds —
    // 0 for a scene with none, which is nearly every scene rendered so far
    // (regression pin: estimateCost.test.ts's "no video reference" cases).
    // A `null` entry (assets.duration_s the browser could not measure at
    // upload time) turns the whole sum, and therefore this scene's quote,
    // into +Infinity rather than a guessed finite number — see
    // clipCostUsd's own comment in ./models for why that direction is the
    // only safe one for a spend-cap check built on this total.
    const videoReferences = scene.videoReferenceDurationsS ?? [];
    // Gemini permits one source video only. The normal video-rate formula
    // accepts many Seedance references, so reject the Gemini-only invalid
    // shape here rather than quote a render the worker must refuse.
    if (billedModel.id === "gemini-omni-video" && videoReferences.length > 1) {
      totalUsd = Number.POSITIVE_INFINITY;
      continue;
    }
    const referenceVideoInputSecondsS = videoReferences.reduce<number>(
      (sum, durationS) => (durationS === null ? Number.POSITIVE_INFINITY : sum + durationS),
      0,
    );
    totalUsd += clipCostUsd(billedModel, {
      resolution,
      durationS: scene.duration_s,
      // pricingAudioOn, not renderAudioOn: this argument picks a RATE TABLE,
      // and every Seedance render sets generate_audio true. See
      // pricingAudioOn's own comment for why the two questions were one flag
      // and what that cost.
      audioOn: pricingAudioOn(billedModel, resolution, scene.is_talking_head, audioEnabled),
      referenceVideoInputSecondsS,
    });
  }

  return {
    totalUsd,
    talkingHeadCount,
    silentCount,
    seconds,
    audioEnabled,
    resolution: settings.resolution,
    silentPerSecondUsd,
  };
}

/**
 * The minimum a scene has to carry to be priced at the model it will
 * actually render on. Deliberately structural rather than the `scenes` Row
 * type: this module is imported by Client Components that only ever get a
 * projection of a scene (components/render-progress.tsx's
 * RenderProgressScene), and requiring the full row here would push a
 * database type into the browser bundle for three fields.
 */
export interface OverridableScene {
  is_talking_head: boolean;
  duration_s: number;
  /** scenes.render_settings_override — a PARTIAL settings object, or null. See 0045_scene_render_settings_override.sql. */
  render_settings_override: unknown;
  /**
   * Optional and carried straight through to EstimatableBrief by
   * estimateUsdForScenes below — see that field's own doc comment. Absent
   * for a scene with no video reference, which is every caller of this
   * type until scene_references.kind admits 'video'.
   */
  videoReferenceDurationsS?: readonly (number | null)[];
}

/**
 * Groups scenes by the settings they will ACTUALLY render on — the project's
 * render_settings merged with each scene's own render_settings_override
 * (0045_scene_render_settings_override.sql), via the one shared
 * mergeRenderSettings helper in lib/models.ts.
 *
 * This exists because every guard and every price in actions/enqueue.ts used
 * to take a single `settings` for a whole batch, which stopped being true
 * the moment one scene in that batch could be pointed at a different model.
 * A batch is now a set of homogeneous groups, and each group is validated
 * and priced against its own model.
 *
 * Grouping rather than per-scene iteration on purpose: estimateCost()
 * returns a batch-level breakdown (talking-head/silent counts, seconds) and
 * the duration/fps guards read best over a set, so one call per DISTINCT
 * effective settings object keeps their semantics intact while still never
 * pricing a scene at a model it isn't rendering on. In the overwhelmingly
 * common case — no scene has an override — this produces exactly one group
 * and every caller behaves identically to what it did before 0045.
 *
 * Keyed on the resolved RenderSettings, not the raw override blob: two
 * scenes whose overrides differ only in a key parseRenderSettings normalises
 * away render identically and must be priced together, not as two groups.
 */
export function groupByEffectiveSettings<T extends OverridableScene>(
  scenes: readonly T[],
  projectRenderSettings: unknown,
): { settings: RenderSettings; scenes: T[] }[] {
  const groups = new Map<string, { settings: RenderSettings; scenes: T[] }>();

  for (const scene of scenes) {
    const settings = mergeRenderSettings(projectRenderSettings, scene.render_settings_override);
    const key = `${settings.model}|${settings.resolution}|${settings.fps}`;
    const existing = groups.get(key);
    if (existing) {
      existing.scenes.push(scene);
    } else {
      groups.set(key, { settings, scenes: [scene] });
    }
  }

  return [...groups.values()];
}

/**
 * THE number the spend caps are checked against. Prices a set of scenes at
 * the model each one will actually render on, and sums.
 *
 * Every cap check in actions/enqueue.ts goes through here rather than
 * calling estimateCost() with the project's raw settings, and that is the
 * whole safety property 0045 turns on: a scene overridden onto a model
 * several times the project's rate, priced at the project's rate, passes
 * assertWithinSpendCaps and then spends real money above the ceiling the
 * operator set. actions/enqueue.test.ts pins exactly that case.
 *
 * Returns only the total, not a merged CostEstimate: `resolution` and
 * `silentPerSecondUsd` are per-group facts that cannot be honestly
 * summarised across a mixed batch, and no cap-checking caller reads anything
 * but totalUsd anyway.
 *
 * script_line/video_prompt are filled in empty when building each group's
 * brief — estimateCost never reads them (only duration_s and
 * is_talking_head feed the math), which is the same shortcut every toBrief()
 * adapter in this codebase already takes.
 */
export function estimateUsdForScenes(
  scenes: readonly OverridableScene[],
  audioEnabled: boolean,
  projectRenderSettings: unknown,
): number {
  return groupByEffectiveSettings(scenes, projectRenderSettings).reduce((total, group) => {
    const brief: EstimatableBrief = {
      character: "",
      scenes: group.scenes.map((scene) => ({
        script_line: "",
        video_prompt: "",
        is_talking_head: scene.is_talking_head,
        duration_s: scene.duration_s,
        // Carried through, not dropped like script_line/video_prompt above:
        // unlike those two, estimateCost DOES read this field, and THE
        // number the spend caps are checked against (this function's own
        // doc comment) must price a scene overridden onto a video
        // reference the same way the render gate's own estimateCost call
        // does, or a cap check here could pass a render that then
        // over-spends against the total the operator actually saw.
        videoReferenceDurationsS: scene.videoReferenceDurationsS,
      })),
    };
    return total + estimateCost(brief, audioEnabled, group.settings).totalUsd;
  }, 0);
}
