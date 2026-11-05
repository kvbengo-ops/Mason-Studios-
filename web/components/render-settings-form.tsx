"use client";

import { useOptimistic, useState, useTransition } from "react";
import type { JSX, ReactNode } from "react";
import { toast } from "sonner";
import {
  clipCostUsd,
  VIDEO_MODELS,
  getModel,
  pickModel,
  compileCostUsd,
  priceForSecond,
  estimatedRefFrameCostUsd,
  isFpsAllowedForDuration,
  isResolutionAllowedForDuration,
  maxDurationForFps,
  maxDurationForResolution,
  type RenderSettings,
  type CompilerModelDescriptor,
  type VideoModelDescriptor,
} from "@/lib/models";
import { effectiveRender } from "@/lib/effective-render";
import { updateRenderSettings } from "@/actions/render-settings";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const perSecondFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 3,
});

/** The ad this panel prices. Every row below is "for one of these". */
export const AD_SECONDS = 30;

/**
 * How many reference frames a 30-second ad bills for.
 *
 * actions/frames.ts generates exactly ONE reference frame per scene
 * (generateSceneFrame, once per row of `scenes`), and the frame is paid for
 * before any video is, so a quote that names only compile + video is short
 * by this many image calls every time. Five scenes of six seconds is the
 * shape the design prices, and it is the conservative direction: cutting the
 * same 30 seconds into FEWER, longer scenes bills fewer frames, so five can
 * only overstate a coarse cut, never understate it. A finer cut spends more
 * per frame, which is exactly why the count is named on the row rather than
 * folded silently into a total.
 */
export const REF_FRAMES_PER_30S_AD = 5;

/**
 * Round a dollar amount UP to the cent.
 *
 * The itemised table has to add up on screen — three rows formatted to cents
 * under a total is an arithmetic claim, and a total computed from raw floats
 * can land a cent away from the rows above it. So each row is rounded here
 * first and the total is the sum OF THE ROUNDED ROWS: the column always
 * reconciles, and every rounding goes up, never down. lib/models.ts's own
 * rule (see priceForSecond's own doc comment) is that a wrong number must
 * overstate; a half-cent of pessimism per row is the version of that rule
 * this table can enforce.
 *
 * The epsilon absorbs float noise so an exact figure is not pushed up a
 * whole cent: 30 x $0.315 is 9.450000000000001 in IEEE754, and ceil()ing
 * that unguarded would quote $9.46 for a bill of exactly $9.45.
 */
function ceilToCents(usd: number): number {
  return Math.ceil(usd * 100 - 1e-9) / 100;
}

/** One priced line of the "With these choices" table. */
type CostRow = { readonly key: string; readonly label: string; readonly usd: number };

/**
 * The itemised cost of one 30-second ad: compile, reference frames, video.
 *
 * Reference frames used to be missing entirely — the panel quoted compile +
 * video and called that the price of an ad, while every scene in that ad
 * bills an image call first (see REF_FRAMES_PER_30S_AD).
 */
function costRowsFor30s({
  compilerModel,
  videoModel,
  resolution,
}: {
  compilerModel: CompilerModelDescriptor;
  videoModel: VideoModelDescriptor;
  resolution: string;
}): { rows: readonly CostRow[]; totalUsd: number } {
  const rows: CostRow[] = [
    // The compile picker itself moved to the Script page (beside the
    // Compile button that actually spends it) — this row did NOT move with
    // it. compileCostUsd is billed once per ad no matter which card the
    // control lives on, so dropping the row would leave a total labelled
    // "per 30s ad" silently short by a real charge. `compilerModel` here is
    // therefore a REPORT of the choice made on Script (passed in resolved
    // server-side via parseCompilerModel), not a control — this card can no
    // longer change it, only price it.
    {
      key: "compile",
      label: `compile · ${compilerModel.label}`,
      usd: ceilToCents(compileCostUsd(compilerModel)),
    },
    {
      key: "frames",
      label: `${REF_FRAMES_PER_30S_AD} reference frames`,
      usd: ceilToCents(REF_FRAMES_PER_30S_AD * estimatedRefFrameCostUsd()),
    },
    {
      key: "video",
      label: `${AD_SECONDS}s video · ${videoModel.label}`,
      // audioOn is the model's own capability, not a scene fact: this row
      // prices a hypothetical 30s ad with no brief behind it, so there are
      // no is_talking_head flags to consult. A real Kling ad is a mix of
      // spoken scenes at $0.135/s and silent B-roll at $0.09/s, and the
      // upper bound (native audio on) is the direction this screen is
      // allowed to be wrong in — same rule priceForSecond's own doc
      // comment states for an unpriced pair.
      usd: ceilToCents(
        clipCostUsd(videoModel, {
          resolution,
          durationS: AD_SECONDS,
          audioOn: videoModel.nativeAudio,
        }),
      ),
    },
  ];

  return { rows, totalUsd: rows.reduce((sum, row) => sum + row.usd, 0) };
}

/**
 * How much more expensive a resolution is than the cheapest one this model
 * offers — the relative marker the design asks for ("1080p 2.5x") in place
 * of a second absolute per-second price.
 *
 * Rounded up (3.65x reads as 3.7x) for the same reason the money is: the
 * marker is a warning about an upgrade, and an upgrade that looks cheaper
 * than it is, is the failure worth avoiding.
 *
 * Passes model.nativeAudio as audioOn, same as the tooltip above and the
 * 30s estimate row: Kling is the one model that carries a sound surcharge,
 * and both of those quote Kling at its sound rate, so pricing this off the
 * silent table disagreed with both of them (1.3x off
 * silent 18/pro vs the sound rates' 27/20 = 1.35x, which rounds up to 1.4x
 * under this function's own round-up rule) — two money numbers on one
 * screen that disagree, the exact failure this comment used to warn about
 * instead of avoiding. Seedance is unaffected either way (nativeAudio
 * false, so this is just the silent table again).
 */
function resolutionMultiplier(model: VideoModelDescriptor, resolution: string): number | null {
  const rates = model.allowedResolutions.map((candidate) =>
    priceForSecond(model, candidate, model.nativeAudio),
  );
  const cheapest = Math.min(...rates);
  if (!(cheapest > 0) || !Number.isFinite(cheapest)) return null;

  const multiplier = priceForSecond(model, resolution, model.nativeAudio) / cheapest;
  // Below a rounded 1.1x there is nothing to warn about, and "1.0x" beside
  // the cheapest option is noise.
  if (multiplier < 1.05) return null;
  return Math.ceil(multiplier * 10) / 10;
}

/**
 * One labelled block of the panel: the label sits ABOVE its buttons rather
 * than in a fixed-width gutter beside them, so the label has room to state
 * the CADENCE of the prices in the row it heads. "Compile" and "Video" alone
 * left "$0.12" and "$0.315" sitting in the same control group with nothing
 * saying one is charged once per ad and the other every second.
 */
function OptionRow({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

/**
 * One option button. Reused from render-gate.tsx.
 */
function OptionButton({
  selected,
  disabled,
  title,
  onClick,
  children,
}: {
  selected: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
  children: ReactNode;
}): JSX.Element {
  // A disabled button never receives hover — components/ui/button.tsx sets
  // disabled:pointer-events-none — so a `title` on the button itself reaches
  // the DOM and no browser ever paints it.
  //
  // The wrapper is not disabled, so it does receive hover and the tooltip
  // appears. Only wrapped when there is something to say and the button
  // cannot speak for itself; an enabled chip keeps its own title, where the
  // element the pointer is already over is the one carrying the text.
  const button = (
    <Button
      type="button"
      size="sm"
      variant={selected ? "default" : "outline"}
      disabled={disabled}
      title={disabled ? undefined : title}
      onClick={onClick}
      className={cn("h-7 px-2.5 text-xs font-medium", disabled && "opacity-50")}
    >
      {children}
    </Button>
  );

  if (disabled && title) {
    return (
      <span title={title} className="inline-flex">
        {button}
      </span>
    );
  }
  return button;
}

/** The trailing amount on an option button. */
function Amount({ children }: { children: ReactNode }): JSX.Element {
  return <span className="ml-1.5 opacity-70">{children}</span>;
}

export function RenderSettingsForm({
  projectId,
  initialRenderSettings,
  compilerModel,
  longestSceneS = 0,
  audioEnabled,
  sceneCount = 0,
  overriddenSceneCount = 0,
  readOnly = false,
}: {
  projectId: string;
  initialRenderSettings: RenderSettings;
  /**
   * The project's current compiler model, resolved server-side with
   * parseCompilerModel(project.render_settings) — no longer a control this
   * card owns. The picker that used to live here moved to the Script page
   * (script-setup-form.tsx's CompileAction), which sits next to the button
   * that actually spends this charge; this card only REPORTS the choice so
   * the "With these choices" total below stays honest about what a 30s ad
   * really costs. See that row's own comment for why it stayed rather than
   * being dropped along with the picker.
   */
  compilerModel: CompilerModelDescriptor;
  /** How many scenes this project has, and how many carry their own render_settings_override. */
  /** lib/models.ts's isAudioEnabled(), resolved server-side — AUDIO_ENABLED is not NEXT_PUBLIC_. Feeds pickModel; see videoModel below. */
  audioEnabled: boolean;
  sceneCount?: number;
  overriddenSceneCount?: number;
  /**
   * Longest scene in the project, in seconds — the cross-field rules need
   * it: some frame rates, and some resolutions, are only legal up to a
   * duration (isFpsAllowedForDuration, isResolutionAllowedForDuration).
   *
   * Optional with a 0 default because a project with no compiled scenes yet
   * has no longest scene, and 0 makes every combination legal, which is the
   * honest answer before there is anything to constrain.
   */
  longestSceneS?: number;
  readOnly?: boolean;
}): JSX.Element {
  const [savedRenderSettings, setSavedRenderSettings] = useState(initialRenderSettings);

  const [renderSettings, applyOptimisticRender] = useOptimistic(
    savedRenderSettings,
    (_state: RenderSettings, next: RenderSettings) => next,
  );

  const [, startTransition] = useTransition();

  // What a scene will ACTUALLY render on, when that is decidable here.
  //
  // pickModel substitutes an audio model for Seedance 2.5 on any scene that
  // is not talking-head OR when audio is off for the account. This card
  // prices a whole 30s ad and cannot know the talking-head mix — but the
  // account-wide case IS knowable: with audio off, NO scene can use an
  // audio model, so every second of this estimate would be billed at the
  // substitute's rate. Quoting the picked model there is a total for a
  // render that cannot happen.
  //
  // With audio on it stays the picked model, which is right for the
  // talking-head scenes and the closest honest answer for a mix this card
  // cannot see.
  const pickedModel = getModel(renderSettings.model);
  const videoModel =
    !audioEnabled && pickedModel.nativeAudio ? pickModel(true, false, renderSettings) : pickedModel;
  const videoModelSubstituted = videoModel.id !== pickedModel.id;
  const { rows, totalUsd } = costRowsFor30s({
    compilerModel,
    videoModel,
    resolution: renderSettings.resolution,
  });

  async function saveRenderSettings(next: RenderSettings): Promise<void> {
    startTransition(async () => {
      applyOptimisticRender(next);
      try {
        const result = await updateRenderSettings(projectId, next);
        if (result?.error) {
          toast.error(result.error);
          return;
        }
        setSavedRenderSettings(next);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to save render settings.");
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Render settings</CardTitle>
        {/* These are the PROJECT's defaults, and every one of them can be
            overridden on a single scene (components/scene-settings-panel.tsx).
            Nothing on this page said so, which made a per-scene override an
            affordance you could only find by already knowing about it. */}
        {/* "any scene can override" was true and useless on its own: it
            describes a possibility, and what an operator needs to know is
            whether it has ALREADY happened. A default that some scenes
            quietly ignore is the one way this card can mislead — the model
            named here is not the model those scenes will render on. Saying
            how many is what turns the line from a capability blurb into an
            answer. */}
        <CardAction className="text-xs text-muted-foreground">
          {videoModelSubstituted
            ? `Audio is off · every scene renders on ${videoModel.label}`
            : overriddenSceneCount > 0
              ? `Project defaults · ${overriddenSceneCount} of ${sceneCount} scene${
                  sceneCount === 1 ? "" : "s"
                } use their own`
              : "Project defaults · any scene can override"}
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="flex flex-col gap-5 rounded-md border border-border bg-muted/30 p-4">
          <OptionRow label="Video — per second">
            {VIDEO_MODELS.map((candidate) => {
              // Priced at the resolution this button would actually leave you
              // on: the selected model keeps the resolution currently chosen,
              // every other one lands on its own default (that is what its
              // onClick sets). Pricing the selected model at its DEFAULT
              // resolution instead would let the button disagree with the
              // table below the moment someone picked 1080p.
              // Priced as the model that would ACTUALLY render, not the one
              // on the button.
              //
              // isTalkingHead: true — this card prices a PROJECT default,
              // and cannot know a scene's roll. True is the case where an
              // audio model survives, so it is the only assumption under
              // which this button could ever be the model that runs; the
              // audio-off substitution below still applies.
              const candidateChoice = effectiveRender({
                settings: {
                  ...renderSettings,
                  model: candidate.id,
                  resolution:
                    candidate.id === videoModel.id
                      ? renderSettings.resolution
                      : pickModel(true, audioEnabled, { model: candidate.id }).defaultResolution,
                },
                durationS: 1,
                isTalkingHead: true,
                audioEnabled,
              });
              const candidateEffective = candidateChoice.effective;
              const candidateSubstituted = candidateChoice.substituted;
              const candidateResolution =
                candidate.id === videoModel.id
                  ? renderSettings.resolution
                  : candidateEffective.defaultResolution;
              const candidatePerSecond = candidateChoice.costUsd;

              return (
                <OptionButton
                  key={candidate.id}
                  selected={candidate.id === videoModel.id}
                  disabled={readOnly}
                  title={
                    candidateSubstituted
                      ? `Audio is off, so this renders on ${candidateEffective.label}: ${perSecondFormatter.format(candidatePerSecond)} per second at ${candidateResolution}`
                      : `${perSecondFormatter.format(candidatePerSecond)} per second at ${candidateResolution}`
                  }
                  onClick={
                    candidate.id !== videoModel.id && !readOnly
                      ? () =>
                          saveRenderSettings({
                            model: candidate.id,
                            resolution: candidate.defaultResolution,
                            fps: candidate.defaultFps,
                          })
                      : undefined
                  }
                >
                  {candidate.label}
                  <Amount>{perSecondFormatter.format(candidatePerSecond)}</Amount>
                </OptionButton>
              );
            })}
          </OptionRow>

          {/* Resolution and frame rate are one decision about the output
              format, and one row. Resolution carries a multiplier rather than
              a second absolute price -- see resolutionMultiplier. */}
          <OptionRow label="Resolution & frame rate">
            {videoModel.allowedResolutions.map((resolution) => {
              const multiplier = resolutionMultiplier(videoModel, resolution);
              // Parity with the frame-rate buttons below, and with the render
              // gate's own resolution row: some resolutions are only legal up
              // to a duration. The Zod schema refuses the write either way —
              // the difference this makes is a control that is visibly
              // unavailable and says why, rather than one that accepts a
              // click and then errors.
              const legal = isResolutionAllowedForDuration(videoModel, resolution, longestSceneS);
              const max = maxDurationForResolution(videoModel, resolution);
              return (
                <OptionButton
                  key={resolution}
                  selected={resolution === renderSettings.resolution}
                  disabled={!legal || readOnly}
                  title={
                    legal
                      ? // Same audioOn as the 30s estimate row above. Without it a
                        // Kling project's tooltip quoted the $0.09 silent second
                        // while the total underneath was built from $0.135 — two
                        // money numbers on one screen that disagree, which is the
                        // exact failure resolutionMultiplier's comment describes.
                        `${perSecondFormatter.format(priceForSecond(videoModel, resolution, videoModel.nativeAudio))} per second`
                      : `${resolution} is only valid up to ${max}s; this project's longest scene is ${longestSceneS}s.`
                  }
                  onClick={
                    !legal || readOnly
                      ? undefined
                      : () => saveRenderSettings({ ...renderSettings, resolution })
                  }
                >
                  {resolution}
                  {multiplier === null ? null : <Amount>{multiplier}&times;</Amount>}
                </OptionButton>
              );
            })}

            {videoModel.allowedFps.map((fps) => {
              const legal = isFpsAllowedForDuration(videoModel, fps, longestSceneS);
              const max = maxDurationForFps(videoModel, fps);
              return (
                <OptionButton
                  key={fps}
                  selected={fps === renderSettings.fps}
                  disabled={!legal || readOnly}
                  title={
                    legal
                      ? undefined
                      : `${fps} fps is only valid up to ${max}s; this project's longest scene is ${longestSceneS}s.`
                  }
                  onClick={
                    readOnly ? undefined : () => saveRenderSettings({ ...renderSettings, fps })
                  }
                >
                  {fps} fps
                </OptionButton>
              );
            })}
          </OptionRow>
        </div>

        {/* Itemised, not a sentence. */}
        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <span className="text-xs font-medium text-muted-foreground">With these choices</span>
          <table className="w-full text-sm">
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <td className="py-0.5 pr-4 text-muted-foreground">{row.label}</td>
                  <td className="py-0.5 text-right tabular-nums text-foreground">
                    {usdFormatter.format(row.usd)}
                  </td>
                </tr>
              ))}
              <tr className="font-semibold text-foreground">
                <td className="pt-1.5 pr-4">per {AD_SECONDS}s ad</td>
                <td className="pt-1.5 text-right tabular-nums">{usdFormatter.format(totalUsd)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {readOnly ? (
          <p className="text-right text-sm text-muted-foreground">
            Read-only — only the project owner can change render settings.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
