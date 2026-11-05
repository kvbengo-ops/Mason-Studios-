import {
  billingResolution,
  clipCostUsd,
  getModel,
  isPriceEstimated,
  pickModel,
  renderAudioOn,
  type RenderSettings,
  type VideoModelDescriptor,
} from "@/lib/models";

/**
 * One answer to "what will this render actually be, and what will it cost".
 *
 * WHY THIS EXISTS, in one paragraph, because the reason is expensive.
 *
 * A scene has a model the operator PICKED and a model that will actually
 * RENDER, and they are frequently not the same: pickModel substitutes an
 * audio model for Seedance 2.5 on any scene that is not talking-head, or
 * whenever audio is off for the account. Every screen that touches money
 * has to know the difference, and for a long time each one worked it out by
 * hand. On 2026-08-30 that produced SEVEN separate defects in a single
 * session — the price, the click handler, the substitution warning, the
 * length list, the resolution list, the project-wide total, and finally the
 * write itself, which set resolution=1080p from a model that was never
 * going to run and turned a button advertised at $0.14/s into a $9.20
 * render on a different model.
 *
 * Six of those were the same mistake wearing different clothes. Fixing them
 * one at a time was never going to end, because nothing structural said the
 * two models were different things — each caller had to remember, and each
 * new caller started from zero.
 *
 * So: callers ask this. They do not call pickModel and priceForSecond in
 * sequence and hope they passed the same arguments to both.
 */
export interface EffectiveRender {
  /** What the operator chose. Use for ✓ marks and "already selected" checks — never for money. */
  picked: VideoModelDescriptor;
  /** What the render will run on. Use for every price, every allowed-values list, and every write. */
  effective: VideoModelDescriptor;
  /** True when the two differ — the caller owes the operator an explanation. */
  substituted: boolean;
  /**
   * Why, in the operator's terms. Null when nothing was substituted.
   *
   * Always null now. There is no "disabled descriptor" tier left for
   * pickModel to substitute away from — every id VIDEO_MODELS recognises is
   * unconditionally selectable (see lib/models.ts's file header) — and
   * pickModel no longer substitutes for "not talking-head" or "audio-off"
   * either (see its own doc comment). The field stays on the shape rather
   * than being deleted: `substituted` itself is still meaningful for a scene
   * whose stored render_settings names a model VIDEO_MODELS has since
   * removed entirely (getModel's own fallback), and a caller reading this
   * field should not have to change when that becomes reachable again.
   */
  reason: "disabled" | null;
  /**
   * Whether this clip renders with sound — renderAudioOn(effective, ...).
   * Load-bearing for the price: kie prices a talking-head second and a
   * silent second as two different measured rates, not one rate times a
   * surcharge.
   */
  audioOn: boolean;
  /** Cost of this scene at the effective model, resolution and length. */
  costUsd: number;
  /** True when `costUsd` rests on a rate nobody has been billed for yet — see isPriceEstimated. */
  costIsUpperBound: boolean;
}

export function effectiveRender({
  settings,
  durationS,
  isTalkingHead,
  audioEnabled,
}: {
  settings: RenderSettings;
  durationS: number;
  isTalkingHead: boolean;
  audioEnabled: boolean;
}): EffectiveRender {
  const picked = getModel(settings.model);
  const effective = pickModel(isTalkingHead, audioEnabled, settings);
  const substituted = effective.id !== picked.id;
  // Decided once, here, and handed out on the result: it prices the clip
  // (kie's sound table is a different rate, not a surcharge) and it tells
  // the worker-side story of whether this clip carries a spoken track.
  // Three callers used to need it and none of them had it.
  const audioOn = renderAudioOn(effective, isTalkingHead, audioEnabled);

  // Unreachable today (see this file's `reason` doc comment) — kept as the
  // general shape rather than collapsed to a bare `null`, so a future
  // substitution cause (a removed model id still named by a stored
  // settings row) has somewhere to report through without every caller's
  // type narrowing changing shape.
  const reason: EffectiveRender["reason"] = substituted ? "disabled" : null;

  // billingResolution, not settings.resolution raw: settings.resolution is
  // ordinarily already valid for `effective` by the time it reaches here
  // (parseRenderSettings/mergeRenderSettings resolve it against the model
  // at read time), but pricing has to be right for a caller a step removed
  // from that too — same belt-and-braces the worker's standardModel keeps.
  // See billingResolution's own doc comment for the Kling bug this closes.
  const resolution = billingResolution(effective, settings.resolution);

  return {
    picked,
    effective,
    substituted,
    reason,
    audioOn,
    costUsd: clipCostUsd(effective, {
      resolution,
      durationS,
      audioOn,
    }),
    costIsUpperBound: isPriceEstimated(effective, resolution, audioOn),
  };
}
