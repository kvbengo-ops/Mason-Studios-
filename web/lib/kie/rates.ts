// kie's rate table, in kie's own unit.
//
// WHY THIS IS NOT lib/models.ts. That table is fal-shaped and cannot be made
// to describe kie without lying. Its rates are dollars per second per
// resolution; kie bills CREDITS per second, prices the same clip differently
// depending on whether the input was an image or a video, runs time-limited
// discounts, and says on its own pricing page that the numbers are beta.
// None of that fits `Record<resolution, number>`.
//
// Forcing it in is not hypothetical — it is what produced $0.1125/s for
// Kling. That number was $0.135 (a real receipt) divided by 1.2 (a fal
// billing quirk), reverse-engineered so a fal-shaped formula would land on a
// kie receipt. Nobody was ever charged $0.1125. The same shape mismatch is
// why Seedance 1080P was pulled from the product entirely: with no kie rate
// recorded it fell back to fal's $1.1497/s, which is TWICE kie's real
// $0.570/s, and a tier that should have cost $2.28 for four seconds was
// quoted at $4.60 and removed as too expensive.
//
// THE RULE THIS FILE ENFORCES: there is no fallback. `rateFor` returns null
// for a pair nobody has priced, and a null must become "not offered" or
// "labelled as unpaid" at the call site — never another vendor's number, and
// never zero. Unknown is not free and unknown is not fal.

/** kie sells credits at 200 to the dollar. The only place this conversion lives. */
export const CREDITS_PER_USD = 200;
const GEMINI_OMNI_PUBLISHED = "2026-09-14";

/** Gemini Omni Video has job prices, not a linear per-second rate. */
export const GEMINI_OMNI_VIDEO_CREDITS = {
  noVideo: {
    "720p": { 4: 63, 6: 84, 8: 105, 10: 126 },
    "1080p": { 4: 63, 6: 84, 8: 105, 10: 126 },
    "4k": { 4: 147, 6: 168, 8: 189, 10: 210 },
  },
  withVideo: { "720p": 168, "1080p": 168, "4k": 252 },
} as const;

export function geminiOmniCredits(
  resolution: string,
  durationS: number,
  withVideo: boolean,
): number | null {
  if (withVideo) {
    return (
      GEMINI_OMNI_VIDEO_CREDITS.withVideo[
        resolution as keyof typeof GEMINI_OMNI_VIDEO_CREDITS.withVideo
      ] ?? null
    );
  }
  return (
    GEMINI_OMNI_VIDEO_CREDITS.noVideo[
      resolution as keyof typeof GEMINI_OMNI_VIDEO_CREDITS.noVideo
    ]?.[durationS as 4 | 6 | 8 | 10] ?? null
  );
}

/** Separate receipt gate for Gemini's fixed-price source-video path. */
export function geminiOmniVideoInputPaid(resolution: string): boolean {
  const rate = KIE_RATES["gemini-omni-video"]?.video?.[resolution];
  return rate !== undefined && rate.provenance === "receipt";
}

/**
 * Where a rate came from, and therefore how much it can be trusted.
 *
 * `receipt` means the kie credit balance was read immediately before and
 * after one render and the difference divided by the requested seconds. That
 * is the only kind of number this product has ever been willing to gate a
 * spend on.
 *
 * `published` means kie's own pricing page says so and we have not paid it
 * yet. Good enough to show an operator with a label attached; not good
 * enough to pretend it is measured. Every published rate here was read off
 * kie's model page on 2026-08-31.
 *
 * THIS USED TO CITE AN AGREEMENT that no longer supports what it claimed:
 * "the one overlap with a receipt — Seedance 2.5 at 720P, 63 cr/s — agreed
 * exactly, which is why the rest of that page is trusted enough to list at
 * all." The receipt is real; what it measured is not established. The
 * measuring script sends no generate_audio field and kie's default for it is
 * true, so that render was probably billed WITH AUDIO — in which case the
 * agreement is between a published silent price and a measured sound one,
 * and proves nothing about either. See the note on that row.
 *
 * Nothing is being asserted in its place. The published rows stay published
 * and stay refused by offerable() unless accepted by name; they are simply no
 * longer propped up by a coincidence.
 */
export type Provenance = "receipt" | "published";

export interface RatePoint {
  /** kie credits per second of OUTPUT. Fractional is legal — kie lists 68.5 for one tier. */
  readonly creditsPerSecond: number;
  readonly provenance: Provenance;
  /** ISO date this rate was read or measured. A rate with no date is a rate nobody can audit. */
  readonly pricedAt: string;
  /**
   * Set when this number is a promotion rather than the standing price.
   * kie's Seedance 1080P is 28% off until this date, and the listed price
   * already reflects the discount — so when it lapses the rate goes UP by
   * about 39%, and every quote built from it moves with no code change.
   */
  readonly promotionEndsAt?: string;
  readonly note?: string;
}

/**
 * Two things kie says about its own prices that this table deliberately does
 * NOT apply, both for the same reason: they would make a quote cheaper than
 * the bill might be.
 *
 * 1. "High-tier top-ups include a +10% bonus, making effective pricing
 *    approximately 10% lower than listed." True, and it depends on which
 *    top-up tier the account last bought at — which nothing here knows. So
 *    quotes overstate by up to 10%. That is the safe direction, and the
 *    ledger stays truthful regardless because runs.cost_usd is written from
 *    creditsConsumed on the real response, not from this table.
 *
 * 2. "Prices are currently in beta and may be adjusted in the future."
 *    Hence pricedAt on every entry. A stale rate should be visible as stale,
 *    not silently wrong.
 */
export const KIE_PRICING_CAVEATS = {
  topUpBonusIgnored: true,
  pricesAreBeta: true,
} as const;

/**
 * kie prices a render differently depending on what went IN, not only what
 * comes out. Their note: "No video = Price x Output; With video = Price x
 * (Input + Output)".
 *
 * Every rate in KIE_RATES below is still the `no video input` column — kie
 * publishes exactly one Price per model/resolution/sound tier, not two, so a
 * video-conditioned render is priced from the SAME row, just multiplied by
 * more seconds (see VIDEO_INPUT_PRICING below). "video" joined this union
 * when that stopped being a hypothetical: 0093_video_reference_elements.sql
 * let an operator upload a video reference element, and this task is the one
 * that lets a render actually carry one. The type still exists so the
 * assumption stays written down rather than assumed — a THIRD input mode
 * kie prices differently would need its own row here, not a silent guess.
 */
export type InputMode = "image" | "video";

/** A resolution as kie itself spells it. Seedance's three are lowercase. */
export type Resolution = string;

export interface KieRates {
  /** Rendered without sound. Every model has this. */
  readonly silent: Readonly<Record<Resolution, RatePoint>>;
  /**
   * Rendered with sound, when the model can. Absent means the model has no
   * audio at all — which is different from "audio costs nothing".
   *
   * kie charges a surcharge for sound rather than a different per-second
   * tier: Kling measured 18 cr/s silent against 27 with sound, same model
   * and resolution. Both numbers are stored outright rather than a base plus
   * a multiplier, because a multiplier is a second thing that can drift from
   * the receipt it came from.
   */
  readonly sound?: Readonly<Record<Resolution, RatePoint>>;
  /**
   * Rendered with a video reference attached. Absent means no receipt for
   * this model, which is a REFUSAL rather than a fallback — see videoRateFor.
   *
   * A THIRD TABLE, not a surcharge on `sound`, for the reason the sound/silent
   * split already gives: a base plus a multiplier is a second thing that can
   * drift from the receipt it came from. It earns its place because the
   * number is not a surcharge at all — attaching a video moves seedance-2.5
   * 480p from 28 cr/s to 17, DOWNWARD, applied to more seconds. No arithmetic
   * on the sound rate produces that.
   *
   * These are with-sound receipts, like every other number in this file:
   * every render this product makes sets generate_audio true, and there is no
   * silent-with-video receipt to separate the two questions. That is why this
   * is one table and not a silent/sound pair.
   */
  readonly video?: Readonly<Record<Resolution, RatePoint>>;
}

const MEASURED = "2026-08-31";
/** The first /ugc clip that actually rendered and billed. */
const SEEDANCE_2_FAST_PUBLISHED = "2026-09-04";
/** Repeated across several notes; one place so the sentence cannot drift. */
const SEEDANCE_2_FAST_MEASURED =
  "MEASURED, not published: 175.5 credits for one 15s 480p render with generate_audio true (task 7374e766, 2026-09-04), read off the credit balance either side -- 24495 before. 175.5 / 15 = 11.7 cr/s exactly, which is the number kie's own page advertised, so the published figure was right and is now a receipt. Measured at 15s rather than 4s because the balance rounds to whole credits: the error is +-0.8% at 15s against +-4% at 4s, and that error would be multiplied into every quote and every cap check. AUDIO=1 deliberately -- every render this product makes sets generate_audio true, and a receipt taken with it off would land in the Silent table, which is the filing mistake that cost a month of unpriced renders.";
const SEEDANCE_2_MEASURED_AT = "2026-09-07";
const SEEDANCE_2_MEASURED =
  "MEASURED, not published: the credit balance read 17797.5 immediately before two renders and 17674.7 immediately after, and 122.8 is exactly 76 + 46.8 -- 19 cr/s for this model's 4s 480p clip (task 285292a952e553ddf502590e1187552b) and 11.7 for seedance-2-fast's, both with generate_audio true. kie's published figure was right, to the credit, and is now a receipt. Measured at 4s rather than 15s because two models were settled in one reading: the balance rounds to whole credits, so a 4s sample carries about +-4% on its own, but the pair summing to the published total to the tenth of a credit is a tighter check than either alone. 720p and 1080p below are STILL PUBLISHED -- nothing has been billed at either, and this route renders 480p only.";
const KIE_PUBLISHED_SOURCE =
  "Read from kie.ai's model page on 2026-09-04. These are the 'no video' column: Price x Output, which is what a render carrying only images and voice costs. That used to be every render this product made, and the sentence here used to say so -- 'never reference_video_urls' -- which stopped being true on 2026-09-09 when a tagged video started reaching the vendor. A scene carrying one is billed from the OTHER column, Price x (Input + Output), AND at a different per-second price -- 17 rather than 28 on the only pair measured; VIDEO_INPUT_PRICING below holds that, and as of 2026-09-10 it is a receipt rather than kie's word. These six rate points are unaffected either way: they are the per-second rate, and the video column changes how many seconds are counted, not what a second costs.";
const NEW_MODELS_PUBLISHED = "2026-10-25";
const SEEDANCE_2_5_PAGE_READ = "2026-10-30";
const SEEDANCE_2_5_PAGE =
  "Read from kie.ai/seedance-2-5 on 2026-10-30 (owner's decision to trust kie's docs): 480P 28 / 720P 63 / 1080P 158 cr/s with no video input, 17 / 38 / 95 with one. Audio is on by default there and carries no separate price; the 480p receipts and the 720p receipt match this table exactly.";
const NEW_MODELS_30S_MEASURED = "2026-10-28";
const KLING_4_REF_PUBLISHED = "2026-10-30";
const KLING_4_REF_MEASURED = "2026-10-30";
const KLING_4_REF_MEASURED_NOTE =
  "MEASURED 2026-10-30: a real /create render, kling-4.0/reference-to-video 4s 720p, one image, task c8b025db6bb080d46b122664da9dd122 -- kie's recordInfo.creditsConsumed 114 = 28.5 cr/s, the published rate exactly. No sound input exists, so one number serves both tiers.";
const KLING_4_REF_PUBLISHED_SOURCE =
  "Read from kie.ai/pricing on 2026-10-30 ('kling 4.0, reference-to-video'). The 'no video input' rows; a render with a video reference is refused rather than guessed.";
const NEW_MODELS_PUBLISHED_SOURCE =
  "Read from kie.ai's model and pricing pages on 2026-10-25. The 'no video' column; no video-input rate is carried, so a render with a video reference is refused rather than guessed.";
const FIRST_CLIP = "2026-09-02";
/** The two renders that first put a video reference on a receipt. */
const VIDEO_MEASURED_AT = "2026-09-10";
/** The render that priced Kling's kie `std` mode (720p) for /ugc. */
const KLING_STD_MEASURED_AT = "2026-09-10";
const KLING_STD_MEASURED =
  "MEASURED, not published: scripts/kie/measure-price.mjs against kling-3.0/video, input " +
  '{mode:"std", duration:15, aspect_ratio:"9:16", sound:true, multi_shots:false, ' +
  "image_urls:[kie example image]} (task 3b90850536f869cf8a385b3a732c7815, 2026-09-10). Balance " +
  "12306.77 before, 300 credits spent (12006.77 after) -- kie's own recordInfo.creditsConsumed " +
  "reads 300.0 exactly. 300 / 15 = 20 cr/s = $0.10/s, against pro's measured 27. Delivered 15.04s " +
  "of audio at 44.1kHz, 1280x720 -- LANDSCAPE: Kling followed the 1672x941 input image's own shape " +
  "and ignored aspect_ratio 9:16 outright -- worker/internal/media's Normalize fills and " +
  "centre-crops to 1080x1920 for this reason (2026-09-10).";
/** The render that priced Kling's kie `std` mode (720p) with sound OFF. */
const KLING_STD_SILENT_MEASURED =
  "MEASURED, not published: scripts/kie/measure-price.mjs against kling-3.0/video, input " +
  '{mode:"std", duration:15, aspect_ratio:"9:16", sound:false, multi_shots:false, ' +
  "image_urls:[kie example image, 1672x941]} (task d255b7ce37697ba706fd4a0e5a2436a8, 2026-09-10). " +
  "Balance 11558.56 before, 210 credits spent (11348.56 after) -- kie's own " +
  "recordInfo.creditsConsumed reads 210.0 exactly. 210 / 15 = 14 cr/s = $0.07/s. Delivered 15.04s, " +
  "1280x720 -- LANDSCAPE, same as the sound receipt: Kling followed the input image's own shape " +
  "and ignored aspect_ratio 9:16. NO audio stream.";

/**
 * WHAT ATTACHING A VIDEO REFERENCE CHANGES ABOUT A BILL — now measured, and
 * the shape is not what this constant said for its first day of life.
 *
 * kie's page states a video-conditioned render is Price x (Input + Output)
 * seconds rather than Price x Output. That structure is CORRECT. What the
 * page does not say, and what cost two renders to find out, is that "Price"
 * is a different number once a video is attached: seedance-2.5 480p bills
 * 17 cr/s with one against 28 without.
 *
 * THIS BLOCK USED TO SAY the same creditsPerSecond simply applied to more
 * seconds, marked `published`, and it was wrong in a way worth keeping a
 * record of. Assuming the rate held predicts 226 credits for a 4s render
 * carrying a 4.064s video; the real bill was 136. On one data point that
 * looks like the formula being refuted, and it was briefly called that. It
 * was the rate all along — 28/17 is 1.65, which is the entire discrepancy.
 * The second render, at 8s, is what turned a puzzle into a line.
 *
 * The arithmetic lives in web/lib/models.ts's clipCostUsd, which reads
 * videoRateFor rather than rateFor when a scene carries video seconds. This
 * is the record of where the number came from.
 */
export const VIDEO_INPUT_PRICING: {
  readonly provenance: Provenance;
  readonly pricedAt: string;
  readonly note: string;
} = {
  provenance: "receipt",
  pricedAt: VIDEO_MEASURED_AT,
  note:
    "MEASURED 2026-09-10 over two production renders -- 136 credits for 4s out and 204 for 8s " +
    "out, same 4.064s video, same 480p, sound on. 17 x (4 + output) reproduces both exactly. " +
    "kie's published Price x (Input + Output) structure holds; the per-second price inside it " +
    "does not -- it falls from 28 to 17 when a video is attached. See seedance-2.5's `video` " +
    "rate point for the isolation against four earlier receipts, and for the one reading this " +
    "still cannot separate: 17 x (input + output) versus a flat 68 plus 17 x output.",
};

/**
 * Rate table, keyed by this module's own model ids.
 *
 * Fifteen rate points (count the creditsPerSecond entries below) across the
 * five models named here — genuinely everything kie has been asked for or
 * has published, and it is the whole product.
 *
 * This used to add "lib/models.ts carries seventeen descriptors, but fourteen
 * are disabled and priced from fal's page" — true when it was written, false
 * since: that file's disabled tier went with fal, and VIDEO_MODELS is now
 * exactly the five models named here, with nothing behind them that cannot
 * be selected.
 */
export const KIE_RATES: Readonly<Record<string, KieRates>> = {
  "gemini-omni-video": {
    // Presence/provenance gate only. Gemini's actual quote comes from
    // geminiOmniCredits above: its published schedule has a fixed
    // intercept, so a credits-per-second figure would be false.
    silent: {
      "720p": {
        creditsPerSecond: 15.75,
        // Receipt 2026-09-14: 4s no-video 720p, kie task ae15bf89e90d9c11f5b1a65e8e3a4d52,
        // creditsConsumed 63 = the published figure. Video input is still published.
        provenance: "receipt",
        pricedAt: GEMINI_OMNI_PUBLISHED,
        note: "Exact per-duration Gemini Omni Video price; see GEMINI_OMNI_VIDEO_CREDITS.",
      },
      "1080p": {
        creditsPerSecond: 15.75,
        provenance: "published",
        pricedAt: GEMINI_OMNI_PUBLISHED,
        note: "Exact per-duration Gemini Omni Video price; see GEMINI_OMNI_VIDEO_CREDITS.",
      },
      "4k": {
        creditsPerSecond: 36.75,
        provenance: "published",
        pricedAt: GEMINI_OMNI_PUBLISHED,
        note: "Exact per-duration Gemini Omni Video price; see GEMINI_OMNI_VIDEO_CREDITS.",
      },
    },
    video: {
      // Marker only: Gemini's video-input price is fixed per job and is
      // resolved from GEMINI_OMNI_VIDEO_CREDITS, never multiplied.
      "720p": {
        creditsPerSecond: 42,
        provenance: "published",
        pricedAt: GEMINI_OMNI_PUBLISHED,
        note: "Fixed 168-credit source-video job price; requires a separate receipt.",
      },
      "1080p": {
        creditsPerSecond: 42,
        provenance: "published",
        pricedAt: GEMINI_OMNI_PUBLISHED,
        note: "Fixed 168-credit source-video job price; requires a separate receipt.",
      },
      "4k": {
        creditsPerSecond: 63,
        provenance: "published",
        pricedAt: GEMINI_OMNI_PUBLISHED,
        note: "Fixed 252-credit source-video job price; requires a separate receipt.",
      },
    },
  },
  "kling-3.0-pro": {
    silent: {
      // 3s render, sound=false, 54 credits.
      "1080p": { creditsPerSecond: 18, provenance: "receipt", pricedAt: MEASURED },
      // kie's `std` mode with sound off — the tier the scripted wizard's
      // B-roll (non-talking-head) scenes render at once a Kling project
      // has picked std/720p. Without this entry those scenes priced at
      // +Infinity (rateFor found no silent 720p row) — see this table's
      // sound["720p"] entry for the corresponding sound receipt.
      "720p": {
        creditsPerSecond: 14,
        provenance: "receipt",
        pricedAt: KLING_STD_MEASURED_AT,
        note: KLING_STD_SILENT_MEASURED,
      },
    },
    sound: {
      // 15s render, sound=true, 405 credits. This is the receipt every
      // earlier version of the price model was reverse-engineered to match.
      "1080p": { creditsPerSecond: 27, provenance: "receipt", pricedAt: MEASURED },
      // kie's `std` mode — /ugc's own tier as of 2026-09-10 (operator
      // decision: renders at real 720p, the /ugc UI displays it as "480p"
      // — see lib/ugc-tier-label.ts). The scripted pipeline's own default
      // stays pro/1080p; this is offered there too now that it has a
      // receipt, just not as the default.
      "720p": {
        creditsPerSecond: 20,
        provenance: "receipt",
        pricedAt: KLING_STD_MEASURED_AT,
        note: KLING_STD_MEASURED,
      },
    },
  },

  "hailuo-2.3-pro": {
    silent: {
      // 10s render, 90 credits. The cheapest second available anywhere on
      // this account — and unreachable for a 4s clip, because this model
      // offers 6s and 10s only.
      "768P": { creditsPerSecond: 9, provenance: "receipt", pricedAt: MEASURED },
    },
  },

  "seedance-2": {
    // 480p IS PAID NOW. 720p and 1080p are not, and offerable() still holds
    // those two back — see each entry's own provenance.
    sound: {
      "480p": {
        creditsPerSecond: 19,
        provenance: "receipt",
        pricedAt: SEEDANCE_2_MEASURED_AT,
        note: SEEDANCE_2_MEASURED,
      },
      "720p": {
        creditsPerSecond: 41,
        provenance: "published",
        pricedAt: SEEDANCE_2_FAST_PUBLISHED,
        note: "41 cr/s. " + KIE_PUBLISHED_SOURCE,
      },
      "1080p": {
        creditsPerSecond: 102,
        provenance: "published",
        pricedAt: SEEDANCE_2_FAST_PUBLISHED,
        note: "102 cr/s. " + KIE_PUBLISHED_SOURCE,
      },
      // 4K is 208 cr/s and deliberately unlisted — $8.32 for a 4s clip. See
      // SEEDANCE_2 in models.ts for why it is not a picker option.
    },
    // No silent tier: every render this product makes sets generate_audio true.
    silent: {},
  },

  "seedance-2-fast": {
    // PUBLISHED, NOT PAID, so offerable() will not sell it yet. One measured
    // render at 480p retires that.
    //
    // Worth carrying anyway: kie's published figures were checked against the
    // six receipts this project holds for seedance 2.5 and matched at every
    // tier -- 28, 63 and 114 cr/s exactly. Not a substitute for a receipt,
    // but a reason to expect one.
    sound: {
      "480p": {
        creditsPerSecond: 11.7,
        provenance: "receipt",
        pricedAt: SEEDANCE_2_FAST_PUBLISHED,
        note: SEEDANCE_2_FAST_MEASURED,
      },
      "720p": {
        creditsPerSecond: 24.8,
        provenance: "published",
        pricedAt: SEEDANCE_2_FAST_PUBLISHED,
        note: "24.8 cr/s, no video input, same page and same day as the 480p figure. Carried because a model that LISTS a resolution must be able to quote it -- cost.test.ts refuses a tier with no rate in either direction, since a picker would otherwise offer it and the quote would then refuse. This model has no 1080p or 4k at all, unlike seedance 2.5 and plain seedance-2.",
      },
    },
    // EMPTY, not absent: the type requires the key, and an empty map is the
    // honest content. Nothing here has a silent price because every render
    // this product makes sets generate_audio true, and copying the sound
    // number across would assert that audio is free -- which kie's own docs
    // deny and cost.test.ts refuses.
    silent: {},
  },

  "seedance-2.5": {
    // WITH A VIDEO REFERENCE ATTACHED. Two production receipts, 2026-09-10,
    // same 4.064s video (@new_video2), same 480p, generate_audio true, two
    // images each — only the output length differed:
    //
    //   4s out -> 136 credits ($0.68)   task b0e0a5e8120f2dfe5f953b82cd6a123d
    //   8s out -> 204 credits ($1.02)   task 49426148c9d828405e65a704c22e98aa
    //
    // Two points fix a unique line: 68 credits over 4 extra seconds is 17
    // cr/s marginal, and the intercept is 68 = 17 x 4 — the video's own
    // length. So 17 x (4 + output) reproduces both bills exactly.
    //
    // THE OUTPUT RATE FALLS, which is the part nobody predicted: 28 cr/s
    // without a video, 17 with one. The published formula is Price x (Input
    // + Output) and it is STRUCTURALLY RIGHT; what nobody had was that
    // "Price" is a different number in the video column. Assuming 28 held
    // predicts 226 credits for the 4s render against a real bill of 136,
    // which is how this was first mis-read as the formula being wrong.
    //
    // ISOLATED, not inferred. Four earlier 4s/480p receipts pin everything
    // else flat: 1 image (112), 2 images + audio (112), 3 images + audio
    // (112), 4 images (112). Image count does not move the bill and neither
    // does audio. The video is the only variable that ever has.
    //
    // WHAT IS STILL NOT SEPARATED: two points give one line and two readings
    // of it — 17 x (input + output), or a flat 68 plus 17 x output. Both fit
    // to the credit. A third render with a DIFFERENT-LENGTH video (not a
    // different output) tells them apart; a different output length cannot,
    // which is exactly what the 8s render already spent. clipCostUsd
    // implements the first reading because it is kie's own published shape.
    video: {
      "480p": {
        creditsPerSecond: 17,
        provenance: "receipt",
        pricedAt: VIDEO_MEASURED_AT,
        note: "MEASURED over two renders, 2026-09-10, and the first receipt this product has ever had for a video-conditioned render. 136 credits for 4s out (task b0e0a5e8120f2dfe5f953b82cd6a123d) and 204 for 8s out (task 49426148c9d828405e65a704c22e98aa), both 480p, generate_audio true, both carrying the same 4.064s video plus two images and one voice. The difference, 68 credits over 4 seconds, is 17 cr/s; the intercept, also 68, is 17 x 4 and matches the video's own length. Both bills are reproduced exactly by 17 x (4 + output). The input is counted as a whole 4, not 4.064 -- 17 x 8.064 would be 137.1 and the bill was 136 -- though whether kie floors the duration or simply read the file as 4.0s is not separable from here. Isolated against four earlier 4s receipts that hold image count (1, 2, 3 and 4) and audio (on and off) flat at 112 credits each, so the video is the only variable that has ever moved this number.",
      },
      "720p": {
        creditsPerSecond: 38,
        provenance: "published",
        pricedAt: SEEDANCE_2_5_PAGE_READ,
        note: SEEDANCE_2_5_PAGE,
      },
      "1080p": {
        creditsPerSecond: 95,
        provenance: "published",
        pricedAt: SEEDANCE_2_5_PAGE_READ,
        note: SEEDANCE_2_5_PAGE,
      },
      // 720p and 1080p absent for the same reason they are absent from the
      // sound table: nothing has been billed at either.
    },
    // SOUND FIRST, because sound is what this product sends. Every /ugc render
    // sets generate_audio true, so this is the table rateFor is asked for in
    // practice; `silent` below is the one that has never been exercised
    // against kie even once.
    sound: {
      "480p": {
        creditsPerSecond: 28,
        provenance: "receipt",
        pricedAt: FIRST_CLIP,
        note: "THE RATE THIS PRODUCT ACTUALLY RENDERS AT, and it was missing until 2026-09-04. Six renders billed 28 cr/s exactly, at five durations spanning everything the product offers: 112 credits for 4s (twice, incl. task e8bce8f7 on 09-03), 140 for 5s (tasks 4ed3b1f9 and 452cf434, $0.70 each), 168 for 6s (task e9dc4e5b, $0.84), 196 for 7s (task 1060d37d, $0.98), 280 for 10s (task 8db36978, $1.40). Every one set generate_audio true, so every one is a SOUND receipt - which is exactly why they belong here and not in Silent, where they all sat until this entry existed. rateFor has no fallback by design, so a sound lookup found nothing and four consecutive production renders that morning logged 'cost estimate unavailable' with estimated_cost_usd=unknown. None of them failed; the only symptom was the log line. The mirrored Silent entry keeps the same number because nothing else is known, and its own note says so - it is the inference, this is the measurement.",
      },
      "720p": {
        creditsPerSecond: 63,
        provenance: "published",
        pricedAt: SEEDANCE_2_5_PAGE_READ,
        note: SEEDANCE_2_5_PAGE,
      },
      "1080p": {
        creditsPerSecond: 158,
        provenance: "published",
        pricedAt: SEEDANCE_2_5_PAGE_READ,
        note: SEEDANCE_2_5_PAGE,
      },
      // 720p and 1080p are ABSENT on purpose. The 720p receipt's audio mode is
      // unknown (see its silent note) and 1080p is a published number that does
      // not say which tier it covers. Copying either here would be a guess
      // wearing a receipt's provenance, and a confident wrong quote is worse
      // than the refusal rateFor gives.
    },
    silent: {
      "480p": {
        creditsPerSecond: 28,
        provenance: "receipt",
        pricedAt: FIRST_CLIP,
        // CORRECTED 2026-09-03. This note used to end "kie returned 1080x1920
        // for it, not a 480-line frame; the resolution field is what is
        // billed, not what is delivered." Task e8bce8f7 falsified that: 480p
        // was ordered and 480x854 came back, billed $0.56 = 112 credits = 28
        // cr/s for 4s, matching the first receipt exactly. kie delivers the
        // tier you pay for, so 480p is NOT a cheap route to 1080p.
        note: "Billed for real at FOUR durations, every length this product offers between 4s and 10s, all on 2026-09-04 unless noted: 112 credits for 4s (twice, incl. task e8bce8f7 on 09-03), 140 for 5s (task 4ed3b1f9, $0.70), 196 for 7s (task 1060d37d, $0.98), 280 for 10s (task 8db36978, $1.40). Each was read off the credit balance either side of the render — 25475 to 25335 for the 5s one — rather than taken from kie's own report, and every one lands on 28 x seconds exactly. THE RATE IS LINEAR AND THE RANGE IS CLOSED: this began as one length measured once and assumed to hold everywhere, and there is no longer a duration in the product priced by inference. The 5s and 10s renders also agreed with kie's OWN reported cost to the cent, so the table and the ledger are independently confirmed rather than merely consistent with each other. All receipts are WITH generate_audio true and therefore SOUND renders sitting in the silent table: no seedance render has ever been made with audio off, so 'audio carries no surcharge' is inferred, not measured — the one thing here still resting on an assumption. Delivery is at the tier ordered: 480p in, 480x854 out.",
      },
      // Kept "receipt" because we WERE billed 63 cr/s for a 720P render —
      // that part is not in doubt. What is in doubt is the tier, which is
      // why the note is here rather than a silent downgrade: changing the
      // provenance would assert a second unmeasured thing to replace the
      // first, and would pull the only sellable 720P pair out from under
      // offerable() on an inference.
      "720p": {
        creditsPerSecond: 63,
        provenance: "receipt",
        pricedAt: MEASURED,
        note: "Billed for real, but the AUDIO MODE of that render is unknown. scripts/kie/measure-price.mjs sent no generate_audio field, and kie documents its default as true with the note that audio costs more — so this may be the SOUND rate sitting in the silent table. The number is a receipt; which tier it belongs to is not. Re-measure with generate_audio explicitly false to settle it, and again with true to fill the sound table that does not exist yet.",
      },
      "1080p": {
        creditsPerSecond: 158,
        provenance: "published",
        pricedAt: SEEDANCE_2_5_PAGE_READ,
        note: SEEDANCE_2_5_PAGE,
      },
    },
  },

  // The three below are PUBLISHED, NOT PAID: offerable() lists them greyed
  // out until one measured render each retires that.
  "seedance-2-mini": {
    sound: {
      "480p": {
        creditsPerSecond: 3.8,
        provenance: "published",
        pricedAt: NEW_MODELS_PUBLISHED,
        note: "3.8 cr/s, no video input. " + NEW_MODELS_PUBLISHED_SOURCE,
      },
      "720p": {
        creditsPerSecond: 8.2,
        provenance: "published",
        pricedAt: NEW_MODELS_PUBLISHED,
        note: "8.2 cr/s, no video input. " + NEW_MODELS_PUBLISHED_SOURCE,
      },
    },
    // No silent tier, for the reason seedance-2-fast gives.
    silent: {},
  },

  "kling-4.0": {
    // ONE price per resolution with or without sound: keyframe-to-video has
    // no sound input, so is_talking_head changes nothing kie bills. Both
    // tiers carry the same number on purpose — cost.test.ts allows this tie
    // by name.
    silent: {
      "720p": {
        creditsPerSecond: 28.5,
        provenance: "receipt",
        pricedAt: NEW_MODELS_30S_MEASURED,
        note: "MEASURED 2026-10-28: scripts/kie/measure-price.mjs, kling-4.0/keyframe-to-video 30s 720p, task 2bb08beb40b26edeb65bd3a7749b5c99 -- 855 credits = 28.5 cr/s, the published rate exactly.",
      },
      "1080p": {
        creditsPerSecond: 42.5,
        provenance: "published",
        pricedAt: NEW_MODELS_PUBLISHED,
        note: "42.5 cr/s. " + NEW_MODELS_PUBLISHED_SOURCE,
      },
    },
    sound: {
      "720p": {
        creditsPerSecond: 28.5,
        provenance: "receipt",
        pricedAt: NEW_MODELS_30S_MEASURED,
        note: "MEASURED 2026-10-28: scripts/kie/measure-price.mjs, kling-4.0/keyframe-to-video 30s 720p, task 2bb08beb40b26edeb65bd3a7749b5c99 -- 855 credits = 28.5 cr/s, the published rate exactly.",
      },
      "1080p": {
        creditsPerSecond: 42.5,
        provenance: "published",
        pricedAt: NEW_MODELS_PUBLISHED,
        note: "42.5 cr/s. " + NEW_MODELS_PUBLISHED_SOURCE,
      },
    },
  },

  // One price with or without sound: kie takes no sound input here. 720p is
  // a receipt (task c8b025db, 2026-10-30); 1080p is still published only.
  "kling-4.0-reference": {
    silent: {
      "720p": {
        creditsPerSecond: 28.5,
        provenance: "receipt",
        pricedAt: KLING_4_REF_MEASURED,
        note: KLING_4_REF_MEASURED_NOTE,
      },
      "1080p": {
        creditsPerSecond: 42.5,
        provenance: "published",
        pricedAt: KLING_4_REF_PUBLISHED,
        note: "42.5 cr/s, no video input. " + KLING_4_REF_PUBLISHED_SOURCE,
      },
    },
    sound: {
      "720p": {
        creditsPerSecond: 28.5,
        provenance: "receipt",
        pricedAt: KLING_4_REF_MEASURED,
        note: KLING_4_REF_MEASURED_NOTE,
      },
      "1080p": {
        creditsPerSecond: 42.5,
        provenance: "published",
        pricedAt: KLING_4_REF_PUBLISHED,
        note: "42.5 cr/s, no video input. " + KLING_4_REF_PUBLISHED_SOURCE,
      },
    },
  },

  "wan-3.0": {
    sound: {
      "480P": {
        creditsPerSecond: 8,
        provenance: "receipt",
        pricedAt: NEW_MODELS_30S_MEASURED,
        note: "MEASURED 2026-10-28: scripts/kie/measure-price.mjs, wan/3-0-video 30s 480P audio on, task 4196d7d8aca2eec6e9fde996c6d40124 -- 240 credits = 8 cr/s, the published rate exactly.",
      },
      "720P": {
        creditsPerSecond: 16,
        provenance: "published",
        pricedAt: NEW_MODELS_PUBLISHED,
        note: "16 cr/s. " + NEW_MODELS_PUBLISHED_SOURCE,
      },
      "1080P": {
        creditsPerSecond: 32,
        provenance: "published",
        pricedAt: NEW_MODELS_PUBLISHED,
        note: "32 cr/s. " + NEW_MODELS_PUBLISHED_SOURCE,
      },
    },
    // No silent tier: every render sends audio on.
    silent: {},
  },
};

/**
 * The rate for one model/resolution/sound combination, or null when nobody
 * has priced it.
 *
 * Null is the point of this function. Every caller must decide what to do
 * with an unpriced pair — hide the option, disable it, or label it — and
 * none of them may substitute a number. The old table answered this question
 * by falling through to fal, and that fallback is the single defect this
 * module exists to remove.
 */
export function rateFor(
  modelId: string,
  resolution: Resolution,
  withSound: boolean,
): RatePoint | null {
  const rates = KIE_RATES[modelId];
  if (!rates) return null;
  if (withSound) {
    // No silent fallback here on purpose. A caller asking for the sound rate
    // of a model that has no sound has a bug, and answering with the silent
    // rate would hide it behind a plausible number.
    return rates.sound?.[resolution] ?? null;
  }
  return rates.silent[resolution] ?? null;
}

/**
 * Rate used by a picker whose global sound setting is enabled.
 *
 * Gemini Omni Video is a silent-output model, but its exact job prices still
 * need the same published/receipt gate as the other models. Keep the special
 * case here rather than weakening rateFor(): callers that ask for an exact
 * sound tier must continue to get null for every other model.
 */
export function offerRateFor(
  modelId: string,
  resolution: Resolution,
  withSound: boolean,
): RatePoint | null {
  const rate = rateFor(modelId, resolution, withSound);
  if (rate || !withSound || modelId !== "gemini-omni-video") return rate;
  return rateFor(modelId, resolution, false);
}

/**
 * The per-second rate for a render CARRYING A VIDEO REFERENCE, or null when
 * this model and resolution have never been billed with one.
 *
 * Null is a refusal, not an invitation to fall back on the sound rate. The
 * two differ by more than a rounding — 17 against 28 on the only pair
 * measured — and in the direction that makes the sound rate an OVERQUOTE, so
 * a fallback would not merely be wrong, it would quietly block renders the
 * operator can afford while looking like a working price.
 */
export function videoRateFor(modelId: string, resolution: Resolution): RatePoint | null {
  return KIE_RATES[modelId]?.video?.[resolution] ?? null;
}

/** Whether a model can render with sound at all. */
export function canRenderWithSound(modelId: string): boolean {
  return KIE_RATES[modelId]?.sound !== undefined;
}

/** True when this rate is published-but-unpaid, and the UI owes the operator a label. */
export function isUnpaidRate(rate: RatePoint): boolean {
  return rate.provenance === "published";
}

/**
 * True when this rate is a promotion that has already lapsed, so the stored
 * number is now too LOW.
 *
 * Takes `now` rather than reading the clock so it is testable and so a
 * server render and a client render cannot disagree about the day.
 */
export function isPromotionExpired(rate: RatePoint, now: Date): boolean {
  return rate.promotionEndsAt !== undefined && now >= new Date(rate.promotionEndsAt);
}
