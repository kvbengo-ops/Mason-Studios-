// Which model/resolution options /ugc's picker may show, and at what price.
//
// Pulled out of app/(app)/ugc/[id]/page.tsx so the list-building logic can be
// unit tested without rendering the page — the page now just calls
// ugcOptions(withSound).
//
// Every pair here has passed offerable()'s gate. The column uses the
// cheapest tier as each model's default and exposes the others in its Resolution menu.
//
// HISTORY. The rule used to be the literal "resolution === 480p" — right for
// every Seedance descriptor, whose defaultResolution IS 480p, and wrong the
// moment a model with a different shape wanted in: the old comment named
// Kling and Hailuo by id and said offering them would mean offering a tier
// this route did not use, so they were excluded on purpose rather than
// silently. The rule then became "this model's own defaultResolution",
// which let Kling in at its one tier, 1080p — still right for every model
// that had exactly one priced tier. It stopped being right on 2026-09-10,
// when kie's `std` mode gave Kling a second, cheaper, sound-priced tier
// (720p, 20 cr/s, against pro/1080p's 27): defaultResolution stayed pro for
// the SCRIPTED pipeline (lib/models.ts's KLING_3_PRO), so filtering on it
// here would have kept quoting /ugc's picker at the more expensive tier
// while a cheaper receipt sat unused. "Cheapest offerable tier" is the rule
// that keeps working the next time a model's default and its cheapest tier
// diverge, instead of needing a third rewrite.
//
// offerable() still does the real gating: since 2026-10-30 a published rate is
// sold too, and only a lapsed promotion is refused (see lib/kie/offerable.ts).
import { offerable } from "@/lib/kie/offerable";
import {
  GEMINI_OMNI_VIDEO_CREDITS,
  geminiOmniVideoInputPaid,
  offerRateFor,
  rateFor,
  videoRateFor,
} from "@/lib/kie/rates";
import { getModel } from "@/lib/models";
import type { UgcOption } from "@/components/ugc-column";

export function ugcOptions(withSound: boolean): UgcOption[] {
  return offerable(withSound).map((offer) => {
    const rate = offerRateFor(offer.model.id, offer.resolution, withSound)!;
    return {
      modelId: offer.model.id,
      label: offer.model.label,
      resolution: offer.resolution,
      durationsS: offer.model.durationsS,
      creditsPerSecond: rate.creditsPerSecond,
      unpaid: rate.provenance === "published",
      // Kling's 2,500, undefined for everything else — see the descriptor's
      // own comment for how it was found. Carried onto the option so the
      // column can refuse an over-long prompt without importing the model
      // table, the same way videoCreditsPerSecond is.
      maxPromptChars: offer.model.maxPromptChars,
      // WHAT A TAGGED VIDEO COSTS, so the confirm dialog can quote the
      // render the operator is actually buying. Null when nobody has been
      // billed for this pair with a video attached; the column refuses to
      // quote rather than falling back on the rate above, which is 28
      // against this one's 17 and would overquote by 65%.
      videoCreditsPerSecond:
        offer.model.id === "gemini-omni-video" && !geminiOmniVideoInputPaid(offer.resolution)
          ? null
          : (videoRateFor(offer.model.id, offer.resolution)?.creditsPerSecond ?? null),
      ...(offer.model.id === "gemini-omni-video"
        ? {
            exactCreditsByDuration: {
              ...GEMINI_OMNI_VIDEO_CREDITS.noVideo[
                offer.resolution as keyof typeof GEMINI_OMNI_VIDEO_CREDITS.noVideo
              ],
            },
            fixedVideoCredits:
              videoRateFor(offer.model.id, offer.resolution)?.provenance === "receipt"
                ? (GEMINI_OMNI_VIDEO_CREDITS.withVideo[
                    offer.resolution as keyof typeof GEMINI_OMNI_VIDEO_CREDITS.withVideo
                  ] ?? null)
                : null,
          }
        : {}),
      // getModel (lib/models.ts), not a string compare against
      // "kling-3.0-pro" — nativeAudio is the model-table flag that already
      // means "is Kling" everywhere else in this product (pickModel,
      // pricingAudioOn, generateClip's own isTalkingHead), so the column
      // asks the same question the same way rather than a fourth spelling
      // of it.
      nativeAudio: getModel(offer.model.id).nativeAudio,
      // BOTH RATES, not just the one `withSound` selected above — Kling's
      // own Sound On/Off control (ugc-column.tsx) has to quote either one
      // regardless of this route's global AUDIO_ENABLED default. Null when
      // this model/resolution has never been billed that way at all (every
      // other model here: neither table matters to it).
      soundCreditsPerSecond:
        rateFor(offer.model.id, offer.resolution, true)?.creditsPerSecond ?? null,
      silentCreditsPerSecond:
        rateFor(offer.model.id, offer.resolution, false)?.creditsPerSecond ?? null,
    };
  });
}
