// The three models kie actually serves, described in kie's own terms.
//
// Nothing here imports lib/models.ts, and that is the whole point. That file
// describes fal: its `endpoint` field holds a fal path
// ("fal-ai/kling-video/v3/pro/image-to-video"), and the worker's kie client
// keys its own model table off those strings — so kie is currently reached
// by looking up a fal endpoint that no request will ever be sent to. The
// vendor we use is an exception inside a table describing the vendor we
// don't.
//
// This module inverts that. kie's model id is the identity; there is no fal
// endpoint anywhere in it.
//
// SCOPE: web-side pricing, validation and UI only. worker/internal/kie now
// mirrors this table on the Go side (models.go's Rates/Descriptor,
// replacing the deleted internal/fal package outright) — see that file's
// own header for the drift test that keeps the two in sync.

import { KIE_RATES, canRenderWithSound, type Resolution } from "@/lib/kie/rates";

/** What /ugc offers; mirrors worker/internal/kie/models.go's VideoAspectRatios. 9:16 is the default. */
export const VIDEO_ASPECT_RATIOS = ["9:16", "16:9", "1:1"] as const;
export type VideoAspectRatio = (typeof VIDEO_ASPECT_RATIOS)[number];

const seconds = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

export interface KieModel {
  /** This product's id. Kept identical to lib/models.ts's ids so a scene row written by either side is readable by both during the transition. */
  readonly id: string;
  /** The string kie itself expects on the wire — see worker/internal/kie/models.go's table, which this mirrors. */
  readonly kieModelName: string;
  readonly label: string;
  /**
   * Resolutions in the spelling kie uses, cheapest first.
   *
   * Casing is per-model, from kie's own enums: Seedance takes "480p"/"720p"/"1080p" and
   * Kling takes "720p"/"1080p". That is kie's own inconsistency, not a typo
   * — the worker maps Kling's to a `mode` of std/pro/4K anyway. Normalising
   * it here would mean translating back at the boundary, so it stays
   * verbatim.
   */
  readonly resolutions: readonly Resolution[];
  readonly defaultResolution: Resolution;
  /** Whole seconds kie accepts. Not a range — Hailuo genuinely offers two values. */
  readonly durationsS: readonly number[];
  /** Ratios /ugc may pick for this model; absent means it renders 9:16 only. */
  readonly aspectRatios?: readonly VideoAspectRatio[];
  /**
   * Longest `prompt` kie will accept for this model, in characters, or
   * absent when it has no known limit.
   *
   * MIRRORS lib/models.ts's VideoModelDescriptor.maxPromptChars and is
   * pinned to it by models.test.ts — two tables describing the same vendor
   * is how a limit gets fixed in one and not the other.
   */
  readonly maxPromptChars?: number;
  /**
   * Longest clip anyone here has actually rendered on this model.
   *
   * Separate from `durationsS` because kie's Seedance page advertises up to
   * 30 seconds while this product has never sent more than 15, and a limit
   * nobody has tested is not the same fact as a limit the vendor documents.
   */
  readonly longestRenderedS: number;
  readonly note?: string;
}

/**
 * Kling 3.0 — the only model here that can produce sound, and (once a
 * silent render is reachable) the cheapest 4-second clip on the account.
 *
 * Two kie modes, both measured: `std` at 20 cr/s with sound (720p — kie's
 * own resolution, not a display fiction; see lib/ugc-tier-label.ts for why
 * /ugc's picker still shows it as "480p") and `pro` at 27 cr/s (1080p).
 * "Pro" left the label on 2026-09-10 because std is not pro — the id stays
 * "kling-3.0-pro" regardless: it is persisted in render_settings and in
 * every run already on record, and renaming it would strand both.
 *
 * Cheapest first, per this field's own doc comment. defaultResolution stays
 * 1080p/pro — that is the scripted pipeline's default and does not change
 * here; /ugc's own default is std/720p, decided in lib/ugc-options.ts by
 * the cheapest-offerable-tier rule, not by this field.
 */
export const KLING_3_PRO: KieModel = {
  id: "kling-3.0-pro",
  kieModelName: "kling-3.0/video",
  label: "Kling 3.0",
  resolutions: ["720p", "1080p"],
  defaultResolution: "1080p",
  durationsS: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  aspectRatios: VIDEO_ASPECT_RATIOS,
  // kie answered a 4,740-character /ugc prompt with code=422 naming this
  // number exactly, on 2026-09-11, after the spend was approved. See
  // lib/models.ts's KLING_3_PRO for the full account.
  maxPromptChars: 2500,
  longestRenderedS: 15,
  note: "Native audio. std/720p is 20 cr/s with sound; pro/1080p is 27. Silent pro at 18 cr/s is cheaper per second than Seedance at any tier above 480P, and at a higher resolution.",
};

/**
 * Hailuo 2.3 Pro — the cheapest second available, and unusable for the
 * four-second workflow.
 */
export const HAILUO_2_3_PRO: KieModel = {
  id: "hailuo-2.3-pro",
  kieModelName: "hailuo/2-3-image-to-video-pro",
  label: "Hailuo 2.3 Pro",
  resolutions: ["768P"],
  defaultResolution: "768P",
  // Two values, not a range. A 4s request is rejected outright, which is why
  // the cheapest per-second model cannot serve the cheapest workflow.
  //
  // This replaces something the old fal-shaped table said in prose. That
  // descriptor carried a `caveat` string — "what choosing this model costs
  // beyond the price on the button" — and Hailuo's read "Silent, no native
  // audio; a talking-head scene picked onto this model is substituted for the
  // audio route." Both halves of that are now false: the substitution was
  // removed when a Kling project started rendering its own B-roll, and the
  // field went with fal.
  //
  // The loss is smaller than it looks, and the replacement is better. A
  // caveat could only DESCRIBE the limit; `durationsS` ENFORCES it — the
  // picker cannot offer 4s on this model, quoteClip refuses it with
  // `unsupported-duration`, and nobody has to read a sentence to find out.
  // Structure beats prose wherever the rule can be expressed as data.
  durationsS: [6, 10],
  longestRenderedS: 10,
};

/** Gemini's job-price model. /ugc labels its real 720p tier as 480p only. */
export const GEMINI_OMNI_VIDEO: KieModel = {
  id: "gemini-omni-video",
  kieModelName: "gemini-omni-video",
  label: "Gemini Omni Video",
  resolutions: ["720p", "1080p", "4k"],
  defaultResolution: "720p",
  durationsS: [4, 6, 8, 10],
  longestRenderedS: 0,
  note: "Published pricing only; held out of /ugc until a paid receipt exists.",
};

/**
 * Seedance 2.5 — no longer the only model with more than one resolution
 * (Kling has two priced tiers now; Seedance 2 and 2 Fast list several
 * each), but still the one whose 480P tier is what the competitor's
 * editors actually run.
 */
export const SEEDANCE_2_5: KieModel = {
  id: "seedance-2.5",
  kieModelName: "bytedance/seedance-2-5",
  label: "Seedance 2.5",
  resolutions: ["480p", "720p", "1080p"],
  // 480P, not 720P. The old table had no 480P entry at all, so every render
  // went out at 2.25x the cheapest available rate — and this is the tier the
  // workflow this route is built for uses.
  defaultResolution: "480p",
  durationsS: seconds(4, 30),
  aspectRatios: VIDEO_ASPECT_RATIOS,
  longestRenderedS: 30,
};

/**
 * The cheap tier of ByteDance's 2.0 line, and the answer to "same clip, less
 * money": 11.7 cr/s at 480p against 2.5's measured 28, for the same 4s 9:16
 * clip the editors already make -- $0.234 against $0.56.
 *
 * SAME MODEL FAMILY, so nothing new is plumbed: the worker reuses
 * seedanceInput unchanged, and kie takes the same field names.
 *
 * Narrower in two places. Resolution stops at 720p (no 1080p, no 4k), and
 * audio references are 3 files of 2-15s against 2.5's 10 of 2-30s -- see the
 * descriptor's comment in worker/internal/kie/models.go for why the second
 * one is a follow-up rather than part of this change.
 */
const SEEDANCE_2_FAST: KieModel = {
  id: "seedance-2-fast",
  kieModelName: "bytedance/seedance-2-fast",
  label: "Seedance 2.0 Fast",
  resolutions: ["480p", "720p"],
  defaultResolution: "480p",
  durationsS: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  aspectRatios: VIDEO_ASPECT_RATIOS,
  longestRenderedS: 0,
  note: "720p enabled by user approval at the published price; billing remains unverified. 1080p is held back.",
};

/**
 * ByteDance's 2.0 proper: cheaper than 2.5 at every tier (19 cr/s at 480p
 * against 28) and the only model here that reaches 4K on kie's side.
 *
 * 4K IS NOT LISTED. It is 208 cr/s — $8.32 for a 4s clip, against a balance
 * that has been near $100. A tier that can spend a third of the weekly team
 * budget on one press is a decision, not a picker default.
 */
const SEEDANCE_2: KieModel = {
  id: "seedance-2",
  kieModelName: "bytedance/seedance-2",
  label: "Seedance 2.0",
  resolutions: ["480p", "720p", "1080p"],
  defaultResolution: "480p",
  durationsS: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  aspectRatios: VIDEO_ASPECT_RATIOS,
  longestRenderedS: 0,
  note: "Published rate, nothing rendered on it yet — offerable() holds it back until one is.",
};

/**
 * ByteDance's smallest 2.0 tier — https://docs.kie.ai/market/bytedance/seedance-2-mini.
 * Same wire shape as the other Seedances; at most 9 reference images, not 10.
 */
const SEEDANCE_2_MINI: KieModel = {
  id: "seedance-2-mini",
  kieModelName: "bytedance/seedance-2-mini",
  label: "Seedance 2.0 Mini",
  resolutions: ["480p", "720p"],
  defaultResolution: "480p",
  durationsS: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  aspectRatios: VIDEO_ASPECT_RATIOS,
  longestRenderedS: 0,
  note: "Published rate, nothing rendered on it yet — offerable() holds it back until one is.",
};

/**
 * Kling 4.0, keyframe-to-video only — https://docs.kie.ai/market/kling/v4-keyframe-to-video.
 * Start and end frame like Kling 3.0, and no @tags: the prompt may only
 * mention frames it was sent. No sound input at all, one price either way.
 */
export const KLING_4: KieModel = {
  id: "kling-4.0",
  kieModelName: "kling-4.0/keyframe-to-video",
  label: "Kling 4.0",
  resolutions: ["720p", "1080p"],
  defaultResolution: "720p",
  durationsS: seconds(3, 30),
  aspectRatios: VIDEO_ASPECT_RATIOS,
  maxPromptChars: 8000,
  longestRenderedS: 30,
  note: "Published rate, nothing rendered on it yet — offerable() holds it back until one is.",
};

/**
 * Kling 4.0, reference-to-video — https://docs.kie.ai/market/kling/v4-reference-to-video.
 * @tags like Seedance (images only, sent as image_urls and named @image_1…),
 * no start/end frame. kie renders sound unasked; there is no flag for it.
 */
export const KLING_4_REFERENCE: KieModel = {
  id: "kling-4.0-reference",
  kieModelName: "kling-4.0/reference-to-video",
  label: "Kling 4.0 Reference",
  resolutions: ["720p", "1080p"],
  defaultResolution: "720p",
  durationsS: seconds(3, 30),
  aspectRatios: VIDEO_ASPECT_RATIOS,
  maxPromptChars: 8000,
  longestRenderedS: 4,
};

/**
 * Wan 3.0 — https://docs.kie.ai/market/wan/3-0-video. Resolutions are
 * uppercase on kie's side, like Hailuo's 768P, and sound is `audio`.
 */
const WAN_3: KieModel = {
  id: "wan-3.0",
  kieModelName: "wan/3-0-video",
  label: "Wan 3.0",
  resolutions: ["480P", "720P", "1080P"],
  defaultResolution: "480P",
  durationsS: seconds(4, 30),
  aspectRatios: VIDEO_ASPECT_RATIOS,
  longestRenderedS: 30,
};

/** Every model kie serves, in the order a picker should show them. */
export const KIE_MODELS: readonly KieModel[] = [
  SEEDANCE_2_5,
  SEEDANCE_2,
  SEEDANCE_2_FAST,
  SEEDANCE_2_MINI,
  KLING_3_PRO,
  KLING_4,
  KLING_4_REFERENCE,
  HAILUO_2_3_PRO,
  WAN_3,
  GEMINI_OMNI_VIDEO,
];

/** The submitted ratio when this model takes it, else undefined (renders 9:16). */
export function videoAspectRatioFor(modelId: string, raw: unknown): VideoAspectRatio | undefined {
  const ratios = kieModel(modelId)?.aspectRatios ?? [];
  return ratios.find((r) => r === raw);
}

/** Lookup by id. Returns null rather than a default — see rates.ts's no-fallback rule. */
export function kieModel(id: string): KieModel | null {
  return KIE_MODELS.find((m) => m.id === id) ?? null;
}

/**
 * The model/resolution pairs that can actually be quoted, in ascending cost.
 *
 * This is what a picker should be built from, not `KIE_MODELS` crossed with
 * `resolutions`: a pair with no rate must not appear as a choice at all.
 * Today every listed pair has a rate, so nothing is filtered out — but the
 * filter is what keeps that true when a model is added and its price has not
 * been read yet.
 */
export function quotablePairs(withSound: boolean): { model: KieModel; resolution: Resolution }[] {
  const pairs: { model: KieModel; resolution: Resolution }[] = [];
  for (const model of KIE_MODELS) {
    if (withSound && !canRenderWithSound(model.id)) continue;
    const table = withSound ? KIE_RATES[model.id]?.sound : KIE_RATES[model.id]?.silent;
    for (const resolution of model.resolutions) {
      if (table?.[resolution] !== undefined) pairs.push({ model, resolution });
    }
  }
  return pairs;
}
