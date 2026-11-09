// Model descriptors, kie's own credit-based rate table, and per-model
// request-body construction — everything the worker needs to know about a
// video model, now that kie.ai is the only vendor.
//
// KEEP IN SYNC: this is the Go counterpart to web/lib/kie/models.ts (shape)
// and web/lib/kie/rates.ts (price) — mirrored field-for-field, including
// the RatePoint/Provenance shape, so a rate changed on one side and not the
// other is a drift the worker/web-side drift test (see
// web/lib/models-drift.test.ts) can actually catch. If you change a rate,
// an allowed value, or add a model, change it on both sides.
//
// HISTORY: before fal.ai was decommissioned, this file's ancestor
// (worker/internal/fal/models.go) described thirteen models — three
// enabled, ten disabled and either unpriced or priced from fal's page for
// endpoints kie could never route to at all. Every disabled descriptor is
// gone, not carried forward disabled: none of them had a kie model id, a
// BuildInput function, or a measured rate, so "disabled" would have meant
// "cannot ever be selected, kept alive for its own sake." What survives is
// exactly the three models this product has ever offered — Seedance 2.5,
// Kling 3.0 Pro, Hailuo 2.3 Pro — matching web/lib/kie/models.ts's
// KIE_MODELS one for one. A second consequence of there being exactly one
// vendor: there is no more "disabled pending verification" tier either.
// Every Descriptor below is therefore always selectable — PickModel's old
// Enabled/DisabledReason/Substituted machinery, which existed solely to
// refuse an unverified fal descriptor and substitute the safe default, has
// nothing left to substitute AWAY FROM and is deleted with it.
//
// PRICE SHAPE CHANGED, not just the vendor. The old Descriptor priced in
// PricePerSecondUSD (a flat map[resolution]float64) with a separate,
// sparse KiePricePerSecondUSD map layered on top for the handful of
// pairs anyone had actually measured on kie, plus a BilledSecondsMultiplier/
// KieAudioSurchargeMultiplier pair standing in for kie's real silent/sound
// distinction. That whole shape was fal's: dollars per second, one number
// per resolution, audio priced as a multiplier fudge because fal's own
// Kling rate had no separate silent tier to measure. kie bills CREDITS per
// second and prices silent and sound-on renders as two genuinely different
// numbers (Kling: 18 cr/s silent, 27 cr/s with sound — not one rate times a
// surcharge). Rates below mirrors web/lib/kie/rates.ts's RatePoint/
// Provenance shape exactly instead of reshaping kie's numbers to fit fal's
// table: see that file's own header for the full argument, and for what it
// cost the one time this codebase tried to force the fit anyway ($0.1125/s
// for Kling, a number nobody was ever charged).
package kie

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// ---------------------------------------------------------------------------
// Rates — kie's own credit-based pricing, mirroring web/lib/kie/rates.ts
// ---------------------------------------------------------------------------

// Provenance says where a rate came from, and therefore how much it can be
// trusted. Mirrors web/lib/kie/rates.ts's type of the same name exactly.
type Provenance string

const (
	// ProvenanceReceipt means a real render's credit balance was read
	// immediately before and after, and the difference divided by the
	// requested seconds. The only kind of number this product has ever
	// been willing to gate a spend on.
	ProvenanceReceipt Provenance = "receipt"
	// ProvenancePublished means kie's own pricing page says so and nobody
	// has paid it yet. Good enough to record and label; not a measurement.
	ProvenancePublished Provenance = "published"
)

// RatePoint is one price: kie credits per second of OUTPUT, at one
// resolution, for either the silent or the sound-on table. Mirrors
// web/lib/kie/rates.ts's RatePoint field for field.
type RatePoint struct {
	// CreditsPerSecond is fractional-legal — kie lists 68.5 for one
	// published tier elsewhere on its pricing page.
	CreditsPerSecond float64
	Provenance       Provenance
	// PricedAt is the ISO date this rate was read or measured. A rate with
	// no date is a rate nobody can audit.
	PricedAt string
	// PromotionEndsAt is set when this number is a promotion rather than
	// the standing price; "" means no promotion. kie's Seedance 1080P is
	// 28% off until this date, and CreditsPerSecond already reflects the
	// discount — so when it lapses the real rate goes UP by about 39% with
	// no code change here. Nothing in this package recomputes a price off
	// this field (see web/lib/kie/rates.ts's isPromotionExpired for the
	// UI-facing staleness check the worker has no equivalent surface for);
	// it is carried purely so a future log/audit can say a quote might be
	// stale.
	PromotionEndsAt string
	Note            string
}

// ModelRates is one model's rate table: resolution -> RatePoint, split by
// whether the render carries sound.
type ModelRates struct {
	// Silent is rendered without sound. Every model has this.
	Silent map[string]RatePoint
	// Sound is rendered with sound, when the model can. nil means the
	// model has no audio at all, which is different from "audio costs
	// nothing" — see rateFor.
	Sound map[string]RatePoint
	// Video is rendered WITH A VIDEO REFERENCE ATTACHED. nil means no
	// receipt for this model, which videoRateFor treats as a refusal rather
	// than a reason to fall back on Sound.
	//
	// A third table rather than a surcharge, because the number is not a
	// surcharge: attaching a video moves seedance-2.5 480p from 28 cr/s to
	// 17, downward, applied to more seconds. Mirrors web/lib/kie/rates.ts's
	// `video` table, which carries the two receipts and the isolation.
	Video map[string]RatePoint
}

const (
	measuredDate = "2026-08-31"
	// BytePlus ModelArk published token prices, read 2026-11-06.
	bytePlusPublished = "2026-11-06"
	// The first /ugc clip that actually rendered and billed.
	firstClipDate = "2026-09-02"
	// Read off kie.ai's own model page, not billed. See the note on
	// seedance-2-fast's rate for why a published number is carried at all.
	seedance2FastPublished = "2026-09-04"
	// Repeated in several notes; kept in one place so the provenance sentence
	// cannot drift between them.
	// The two renders that first put a video reference on a receipt.
	videoMeasuredDate = "2026-09-10"
	// The render that priced Kling's kie `std` mode (720p) for /ugc.
	klingStdMeasuredAt = "2026-09-10"
	klingStdMeasured   = "MEASURED, not published: scripts/kie/measure-price.mjs against kling-3.0/video, input {mode:\"std\", duration:15, aspect_ratio:\"9:16\", sound:true, multi_shots:false, image_urls:[kie example image]} (task 3b90850536f869cf8a385b3a732c7815, 2026-09-10). Balance 12306.77 before, 300 credits spent (12006.77 after) -- kie's own recordInfo.creditsConsumed reads 300.0 exactly. 300 / 15 = 20 cr/s = $0.10/s, against pro's measured 27. Delivered 15.04s of audio at 44.1kHz, 1280x720 -- LANDSCAPE: Kling followed the 1672x941 input image's own shape and ignored aspect_ratio 9:16 outright -- worker/internal/media's Normalize fills and centre-crops to 1080x1920 for this reason (2026-09-10)."
	// The render that priced Kling's kie `std` mode (720p) with sound OFF —
	// the tier the scripted wizard's B-roll (non-talking-head) scenes render
	// at once a Kling project has picked std/720p.
	klingStdSilentMeasured = "MEASURED, not published: scripts/kie/measure-price.mjs against kling-3.0/video, input {mode:\"std\", duration:15, aspect_ratio:\"9:16\", sound:false, multi_shots:false, image_urls:[kie example image, 1672x941]} (task d255b7ce37697ba706fd4a0e5a2436a8, 2026-09-10). Balance 11558.56 before, 210 credits spent (11348.56 after) -- kie's own recordInfo.creditsConsumed reads 210.0 exactly. 210 / 15 = 14 cr/s = $0.07/s. Delivered 15.04s, 1280x720 -- LANDSCAPE, same as the sound receipt: Kling followed the input image's own shape and ignored aspect_ratio 9:16. NO audio stream."
	seedance2FastMeasured  = "MEASURED, not published: 175.5 credits for one 15s 480p render with generate_audio true (task 7374e766, 2026-09-04), read off the credit balance either side -- 24495 before. 175.5 / 15 = 11.7 cr/s exactly, which is the number kie's own page advertised, so the published figure was right and is now a receipt. Measured at 15s rather than 4s because the balance rounds to whole credits: the error is +-0.8% at 15s against +-4% at 4s, and that error would be multiplied into every quote and every cap check. AUDIO=1 deliberately -- every render this product makes sets generate_audio true, and a receipt taken with it off would land in the Silent table, which is the filing mistake that cost a month of unpriced renders."
	// The 480p render that retired seedance-2's published rate.
	seedance2MeasuredAt      = "2026-09-07"
	seedance2Measured        = "MEASURED, not published: the credit balance read 17797.5 immediately before two renders and 17674.7 immediately after, and 122.8 is exactly 76 + 46.8 -- 19 cr/s for this model's 4s 480p clip (task 285292a952e553ddf502590e1187552b) and 11.7 for seedance-2-fast's, both with generate_audio true. kie's published figure was right, to the credit, and is now a receipt. Measured at 4s rather than 15s because two models were settled in one reading: the balance rounds to whole credits, so a 4s sample carries about +-4% on its own, but the pair summing to the published total to the tenth of a credit is a tighter check than either alone. 720p and 1080p below are STILL PUBLISHED -- nothing has been billed at either, and this route renders 480p only."
	kiePublishedSource       = "Read from kie.ai's model page on 2026-09-04. This figure is the 'no video' column: as of worker/internal/kie/models.go's seedanceInput (0094_video_scene_reference.sql, 2026-09-09), this product DOES send reference_video_urls when a scene carries a video reference, and kie prices THAT render as Price x (input + output) instead of Price x output. This per-second number applies only to a render with no video reference attached -- nobody has a receipt yet for what the input+output figure actually is."
	publishedDate            = "2026-08-31"
	geminiOmniPublished      = "2026-09-14"
	geminiOmni12Published    = "2026-11-10"
	newModelsPublished       = "2026-10-25"
	seedance25PageRead       = "2026-10-30"
	seedance25Page           = "Read from kie.ai/seedance-2-5 on 2026-10-30 (owner's decision to trust kie's docs): 480P 28 / 720P 63 / 1080P 158 cr/s with no video input, 17 / 38 / 95 with one. Audio is on by default there and carries no separate price; the 480p receipts and the 720p receipt match this table exactly."
	newModels30sMeasured     = "2026-10-28"
	kling4RefPublished       = "2026-10-30"
	kling4RefMeasured        = "2026-10-30"
	kling4RefMeasuredNote    = "MEASURED 2026-10-30: a real /create render, kling-4.0/reference-to-video 4s 720p, one image, task c8b025db6bb080d46b122664da9dd122 -- kie's recordInfo.creditsConsumed 114 = 28.5 cr/s, the published rate exactly. No sound input exists, so one number serves both tiers."
	kling4RefPublishedSource = "Read from kie.ai/pricing on 2026-10-30 ('kling 4.0, reference-to-video'). The 'no video input' rows; a render with a video reference is refused rather than guessed."
	newModelsPublishedSource = "Read from kie.ai's model and pricing pages on 2026-10-25. The 'no video' column; no video-input rate is carried, so a render with a video reference is refused rather than guessed."
)

// CreditsPerUSD is kie's published exchange rate: 1 credit = $0.005, i.e.
// 200 credits to the dollar. Mirrors web/lib/kie/rates.ts's
// CREDITS_PER_USD — the only place this conversion lives on the Go side.
const CreditsPerUSD = 200

// Gemini Omni Video is priced as exact per-duration jobs, not credits per
// output second. Keep this separate from Rates: making its fixed/intercepted
// prices look linear would change the quote as duration changes.
var geminiOmniNoVideoCredits = map[string]map[int]float64{
	"360p":  {4: 63, 6: 84, 8: 105, 10: 126},
	"720p":  {4: 63, 6: 84, 8: 105, 10: 126},
	"1080p": {4: 63, 6: 84, 8: 105, 10: 126},
	"4k":    {4: 147, 6: 168, 8: 189, 10: 210},
}

var geminiOmniVideoCredits = map[string]float64{
	"360p":  168,
	"720p":  168,
	"1080p": 168,
	"4k":    252,
}

// Rates is kie's rate table, keyed by this package's own model ids (the
// same ids Descriptor.ID and render_settings.model use) — mirrors
// web/lib/kie/rates.ts's KIE_RATES.
//
// Fifteen rate points across five models, matching the web table exactly:
// that is genuinely everything kie has been asked for or has published.
var Rates = map[string]ModelRates{
	"seedance-2.5-byteplus": {
		Sound: map[string]RatePoint{
			"480p":  {CreditsPerSecond: 20.56005, Provenance: ProvenancePublished, PricedAt: bytePlusPublished, Note: "BytePlus ModelArk Seedance 2.5: $10.70/M tokens without video input; estimate uses output pixels at 24 fps. Actual billing uses completion_tokens."},
			"720p":  {CreditsPerSecond: 46.224, Provenance: ProvenancePublished, PricedAt: bytePlusPublished, Note: "BytePlus ModelArk Seedance 2.5: $10.70/M tokens without video input; estimate uses output pixels at 24 fps. Actual billing uses completion_tokens."},
			"1080p": {CreditsPerSecond: 113.724, Provenance: ProvenancePublished, PricedAt: bytePlusPublished, Note: "BytePlus ModelArk Seedance 2.5: $11.70/M tokens without video input; estimate uses output pixels at 24 fps. Actual billing uses completion_tokens."},
		},
		Silent: map[string]RatePoint{
			"480p":  {CreditsPerSecond: 20.56005, Provenance: ProvenancePublished, PricedAt: bytePlusPublished, Note: "BytePlus ModelArk Seedance 2.5: $10.70/M tokens without video input; estimate uses output pixels at 24 fps. Actual billing uses completion_tokens."},
			"720p":  {CreditsPerSecond: 46.224, Provenance: ProvenancePublished, PricedAt: bytePlusPublished, Note: "BytePlus ModelArk Seedance 2.5: $10.70/M tokens without video input; estimate uses output pixels at 24 fps. Actual billing uses completion_tokens."},
			"1080p": {CreditsPerSecond: 113.724, Provenance: ProvenancePublished, PricedAt: bytePlusPublished, Note: "BytePlus ModelArk Seedance 2.5: $11.70/M tokens without video input; estimate uses output pixels at 24 fps. Actual billing uses completion_tokens."},
		},
		Video: map[string]RatePoint{
			"480p":  {CreditsPerSecond: 12.2976, Provenance: ProvenancePublished, PricedAt: bytePlusPublished, Note: "BytePlus ModelArk Seedance 2.5: $6.40/M tokens with video input. Estimate excludes BytePlus's minimum-token floor; actual billing uses completion_tokens."},
			"720p":  {CreditsPerSecond: 27.648, Provenance: ProvenancePublished, PricedAt: bytePlusPublished, Note: "BytePlus ModelArk Seedance 2.5: $6.40/M tokens with video input. Estimate excludes BytePlus's minimum-token floor; actual billing uses completion_tokens."},
			"1080p": {CreditsPerSecond: 68.04, Provenance: ProvenancePublished, PricedAt: bytePlusPublished, Note: "BytePlus ModelArk Seedance 2.5: $7.00/M tokens with video input. Estimate excludes BytePlus's minimum-token floor; actual billing uses completion_tokens."},
		},
	},
	"gemini-omni-video": {
		// Gate/provenance marker only. EstimateCostWithVideo resolves the
		// documented exact job-price tables above; these synthetic values are
		// deliberately never multiplied into a Gemini quote.
		Silent: map[string]RatePoint{
			"360p": {CreditsPerSecond: 15.75, Provenance: ProvenancePublished, PricedAt: geminiOmniPublished},
			// 720p receipt 2026-09-14: kie task ae15bf89e90d9c11f5b1a65e8e3a4d52 billed 63 for 4s.
			"720p":  {CreditsPerSecond: 15.75, Provenance: ProvenanceReceipt, PricedAt: geminiOmniPublished},
			"1080p": {CreditsPerSecond: 15.75, Provenance: ProvenancePublished, PricedAt: geminiOmniPublished},
			"4k":    {CreditsPerSecond: 36.75, Provenance: ProvenancePublished, PricedAt: geminiOmniPublished},
		},
		Video: map[string]RatePoint{
			"360p":  {CreditsPerSecond: 42, Provenance: ProvenancePublished, PricedAt: geminiOmniPublished},
			"720p":  {CreditsPerSecond: 42, Provenance: ProvenancePublished, PricedAt: geminiOmniPublished},
			"1080p": {CreditsPerSecond: 42, Provenance: ProvenancePublished, PricedAt: geminiOmniPublished},
			"4k":    {CreditsPerSecond: 63, Provenance: ProvenancePublished, PricedAt: geminiOmniPublished},
		},
	},
	"gemini-omni-1.2": {
		Silent: map[string]RatePoint{
			"360p":  {CreditsPerSecond: 4, Provenance: ProvenancePublished, PricedAt: geminiOmni12Published},
			"720p":  {CreditsPerSecond: 9, Provenance: ProvenancePublished, PricedAt: geminiOmni12Published},
			"1080p": {CreditsPerSecond: 10, Provenance: ProvenancePublished, PricedAt: geminiOmni12Published},
			"4k":    {CreditsPerSecond: 22, Provenance: ProvenancePublished, PricedAt: geminiOmni12Published},
		},
		Sound: map[string]RatePoint{
			"360p":  {CreditsPerSecond: 4, Provenance: ProvenancePublished, PricedAt: geminiOmni12Published},
			"720p":  {CreditsPerSecond: 9, Provenance: ProvenancePublished, PricedAt: geminiOmni12Published},
			"1080p": {CreditsPerSecond: 10, Provenance: ProvenancePublished, PricedAt: geminiOmni12Published},
			"4k":    {CreditsPerSecond: 22, Provenance: ProvenancePublished, PricedAt: geminiOmni12Published},
		},
	},
	"kling-3.0-pro": {
		Silent: map[string]RatePoint{
			// 3s render, sound=false, 54 credits.
			"1080p": {CreditsPerSecond: 18, Provenance: ProvenanceReceipt, PricedAt: measuredDate},
			// kie's `std` mode with sound off. Mirrors web/lib/kie/rates.ts's
			// "kling-3.0-pro".silent["720p"] — without this entry, a B-roll
			// (non-talking-head) scene on a std/720p Kling project priced at
			// +Infinity (EstimateCost found no silent 720p rate).
			"720p": {
				CreditsPerSecond: 14,
				Provenance:       ProvenanceReceipt,
				PricedAt:         klingStdMeasuredAt,
				Note:             klingStdSilentMeasured,
			},
		},
		Sound: map[string]RatePoint{
			// 15s render, sound=true, 405 credits. This is the receipt every
			// earlier fal-shaped version of the price model was
			// reverse-engineered to match — see this file's own header.
			"1080p": {CreditsPerSecond: 27, Provenance: ProvenanceReceipt, PricedAt: measuredDate},
			// kie's `std` mode — /ugc's own tier as of 2026-09-10. Mirrors
			// web/lib/kie/rates.ts's "kling-3.0-pro".sound["720p"].
			"720p": {
				CreditsPerSecond: 20,
				Provenance:       ProvenanceReceipt,
				PricedAt:         klingStdMeasuredAt,
				Note:             klingStdMeasured,
			},
		},
	},
	"hailuo-2.3-pro": {
		Silent: map[string]RatePoint{
			// 10s render, 90 credits. The cheapest second available anywhere
			// on this account — and unreachable for a 4s clip, since this
			// model only offers 6s and 10s (see its Descriptor below).
			"768P": {CreditsPerSecond: 9, Provenance: ProvenanceReceipt, PricedAt: measuredDate},
		},
	},
	"seedance-2": {
		// 480p IS PAID NOW. 720p and 1080p are not, and offerable() still
		// holds those two back — see each entry's own provenance.
		Sound: map[string]RatePoint{
			"480p": {
				CreditsPerSecond: 19,
				Provenance:       ProvenanceReceipt,
				PricedAt:         seedance2MeasuredAt,
				Note:             seedance2Measured,
			},
			"720p": {
				CreditsPerSecond: 41,
				Provenance:       ProvenancePublished,
				PricedAt:         seedance2FastPublished,
				Note:             "41 cr/s. " + kiePublishedSource,
			},
			"1080p": {
				CreditsPerSecond: 102,
				Provenance:       ProvenancePublished,
				PricedAt:         seedance2FastPublished,
				Note:             "102 cr/s. " + kiePublishedSource,
			},
			// 4K is 208 cr/s and deliberately not offered: $8.32 for a 4s
			// clip, against a balance that has been near $100. A tier that
			// can spend a third of the weekly team budget on one press is a
			// decision, not a default, and nobody has asked for it.
		},
		Silent: map[string]RatePoint{
			// None, for the same reason the other two Seedances have none:
			// every render sets generate_audio true.
		},
	},
	"seedance-2-fast": {
		// PUBLISHED, NOT PAID, and therefore NOT OFFERED YET. offerable()
		// refuses any pair without a receipt, so adding this makes the model
		// exist without making it sellable — which is the correct order.
		// One measured render at 480p retires the label.
		//
		// Why these numbers are worth acting on anyway: kie's published
		// figures were checked against the six receipts this project holds
		// for seedance 2.5 and matched at every tier — 28, 63 and 114 cr/s,
		// exactly. That is not a substitute for a receipt, but it is a
		// reason to expect one.
		//
		// Read from kie.ai's own model page on 2026-09-04. The "no video"
		// column is ours, and it is no longer the only one this product can
		// hit: as of seedanceInput (0094_video_scene_reference.sql,
		// 2026-09-09), a scene carrying a video reference DOES send
		// reference_video_urls, and kie prices that render differently (with
		// video the formula is Price x (input + output) rather than Price x
		// output). These per-second figures are the no-video column and
		// nobody has a receipt yet for the other one.
		Sound: map[string]RatePoint{
			"480p": {
				CreditsPerSecond: 11.7,
				Provenance:       ProvenanceReceipt,
				PricedAt:         seedance2FastPublished,
				Note:             "Against seedance 2.5's measured 28 cr/s this is 58% cheaper for the same 4s 480p 9:16 clip -- $0.234 against $0.56 -- which is why /ugc is pinned to it. " + seedance2FastMeasured,
			},
			"720p": {
				CreditsPerSecond: 24.8,
				Provenance:       ProvenancePublished,
				PricedAt:         seedance2FastPublished,
				Note:             "24.8 cr/s, no video input, same page and same day as the 480p figure. A model that LISTS a resolution has to be able to quote it. There is no 1080p or 4k on this model at all.",
			},
		},
		Silent: map[string]RatePoint{
			// Absent for the same reason seedance 2.5's is: every render this
			// product makes sets generate_audio true, so a silent rate here
			// would be a copy of the sound one asserting that audio is free,
			// which kie's own docs deny.
		},
	},
	"seedance-2.5": {
		// SOUND FIRST, because sound is what this product sends. Every /ugc
		// render sets generate_audio true, so this is the table rateFor is
		// WITH A VIDEO REFERENCE ATTACHED. Two production receipts,
		// 2026-09-10, same 4.064s video, same 480p, sound on, differing only
		// in output length: 136 credits for 4s (task
		// b0e0a5e8120f2dfe5f953b82cd6a123d) and 204 for 8s (task
		// 49426148c9d828405e65a704c22e98aa). 68 credits over 4 extra seconds
		// is 17 cr/s, and the 68 intercept is 17 x 4 — the video's own
		// length — so 17 x (4 + output) reproduces both exactly. Isolated
		// against four earlier 4s receipts that hold image count and audio
		// flat at 112. See web/lib/kie/rates.ts for the full note.
		Video: map[string]RatePoint{
			"480p": {
				CreditsPerSecond: 17,
				Provenance:       ProvenanceReceipt,
				PricedAt:         videoMeasuredDate,
				Note:             "MEASURED over two renders, 2026-09-10: 136 credits for 4s out and 204 for 8s out, both 480p with generate_audio true and the same 4.064s video. 17 x (4 + output) reproduces both to the credit. kie's published Price x (Input + Output) structure is right; the per-second price inside it falls from 28 to 17 when a video is attached. The input is counted whole -- 17 x 8.064 would be 137.1 and the bill was 136 -- though whether kie floors it or read the file as 4.0s is not separable from two samples.",
			},
			"720p":  {CreditsPerSecond: 38, Provenance: ProvenancePublished, PricedAt: seedance25PageRead, Note: seedance25Page},
			"1080p": {CreditsPerSecond: 95, Provenance: ProvenancePublished, PricedAt: seedance25PageRead, Note: seedance25Page},
		},
		// asked for in practice; Silent below is the one that has never been
		// exercised against kie even once.
		Sound: map[string]RatePoint{
			"480p": {
				CreditsPerSecond: 28,
				Provenance:       ProvenanceReceipt,
				PricedAt:         firstClipDate,
				Note:             "THE RATE THIS PRODUCT ACTUALLY RENDERS AT, and it was missing until 2026-09-04. Six renders billed 28 cr/s exactly, at five durations spanning everything the product offers: 112 credits for 4s (twice, incl. task e8bce8f7 on 09-03), 140 for 5s (tasks 4ed3b1f9 and 452cf434, $0.70 each), 168 for 6s (task e9dc4e5b, $0.84), 196 for 7s (task 1060d37d, $0.98), 280 for 10s (task 8db36978, $1.40). Every one set generate_audio true, so every one is a SOUND receipt - which is exactly why they belong here and not in Silent, where they all sat until this entry existed. rateFor has no fallback by design, so a sound lookup found nothing and four consecutive production renders that morning logged 'cost estimate unavailable' with estimated_cost_usd=unknown. None of them failed; the only symptom was the log line. The mirrored Silent entry keeps the same number because nothing else is known, and its own note says so - it is the inference, this is the measurement.",
			},
			// 720p and 1080p are ABSENT on purpose. The 720p receipt's audio
			// mode is unknown (see its Silent note) and 1080p is a published
			// number that does not say which tier it covers. Copying either
			// here would be a guess wearing a receipt's provenance, and a
			// confident wrong quote is worse than the refusal rateFor gives.
			"720p":  {CreditsPerSecond: 63, Provenance: ProvenancePublished, PricedAt: seedance25PageRead, Note: seedance25Page},
			"1080p": {CreditsPerSecond: 158, Provenance: ProvenancePublished, PricedAt: seedance25PageRead, Note: seedance25Page},
		},
		Silent: map[string]RatePoint{
			"480p": {
				CreditsPerSecond: 28,
				Provenance:       ProvenanceReceipt,
				PricedAt:         firstClipDate,
				// CORRECTED 2026-09-03. This note used to end "kie returned
				// 1080x1920 for it, not a 480-line frame; the resolution field
				// is what is billed, not what is delivered." Task e8bce8f7
				// falsified that: 480p was ordered and 480x854 came back,
				// billed $0.56 = 112 credits = 28 cr/s for 4s, matching the
				// first receipt exactly. kie delivers the tier you pay for, so
				// 480p is NOT a cheap route to 1080p — internal/media's
				// scale=1080:1920 is upscaling, and adds no detail.
				Note: "Billed for real at FOUR durations, every length this product offers between 4s and 10s, all on 2026-09-04 unless noted: 112 credits for 4s (twice, incl. task e8bce8f7 on 09-03), 140 for 5s (task 4ed3b1f9, $0.70), 196 for 7s (task 1060d37d, $0.98), 280 for 10s (task 8db36978, $1.40). Each was read off the credit balance either side of the render — 25475 to 25335 for the 5s one — rather than taken from kie's own report, and every one lands on 28 x seconds exactly. THE RATE IS LINEAR AND THE RANGE IS CLOSED: this began as one length measured once and assumed to hold everywhere, and there is no longer a duration in the product priced by inference. The 5s and 10s renders also agreed with kie's OWN reported cost to the cent, so the table and the ledger are independently confirmed rather than merely consistent with each other. All receipts are WITH generate_audio true and therefore SOUND renders sitting in the silent table: no seedance render has ever been made with audio off, so 'audio carries no surcharge' is inferred, not measured — the one thing here still resting on an assumption. Delivery is at the tier ordered: 480p in, 480x854 out.",
			},
			// Kept receipt because we WERE billed 63 cr/s for a 720P
			// render. What is unestablished is which TIER that was: the
			// measuring script sends no generate_audio and kie defaults it
			// to true. The comment here used to say this rate "agreed
			// exactly" with the published one and that the agreement was
			// what made the rest of the table worth listing — see
			// web/lib/kie/rates.ts's header for why that argument is void.
			"720p": {
				CreditsPerSecond: 63,
				Provenance:       ProvenanceReceipt,
				PricedAt:         measuredDate,
				Note:             "Billed for real, but the AUDIO MODE of that render is unknown. scripts/kie/measure-price.mjs sent no generate_audio field, and kie documents its default as true with the note that audio costs more — so this may be the SOUND rate sitting in the silent table. The number is a receipt; which tier it belongs to is not. Re-measure with generate_audio explicitly false to settle it, and again with true to fill the sound table that does not exist yet.",
			},
			"1080p": {CreditsPerSecond: 158, Provenance: ProvenancePublished, PricedAt: seedance25PageRead, Note: seedance25Page},
		},
	},

	// The three below are PUBLISHED, NOT PAID — mirrors web/lib/kie/rates.ts.
	"seedance-2-mini": {
		Sound: map[string]RatePoint{
			"480p": {
				CreditsPerSecond: 3.8,
				Provenance:       ProvenancePublished,
				PricedAt:         newModelsPublished,
				Note:             "3.8 cr/s, no video input. " + newModelsPublishedSource,
			},
			"720p": {
				CreditsPerSecond: 8.2,
				Provenance:       ProvenancePublished,
				PricedAt:         newModelsPublished,
				Note:             "8.2 cr/s, no video input. " + newModelsPublishedSource,
			},
		},
		Silent: map[string]RatePoint{},
	},
	// One price with or without sound: keyframe-to-video has no sound input.
	"kling-4.0": {
		Silent: map[string]RatePoint{
			"720p": {
				CreditsPerSecond: 28.5,
				Provenance:       ProvenanceReceipt,
				PricedAt:         newModels30sMeasured,
				Note:             "MEASURED 2026-10-28: scripts/kie/measure-price.mjs, kling-4.0/keyframe-to-video 30s 720p, task 2bb08beb40b26edeb65bd3a7749b5c99 -- 855 credits = 28.5 cr/s, the published rate exactly.",
			},
			"1080p": {
				CreditsPerSecond: 42.5,
				Provenance:       ProvenancePublished,
				PricedAt:         newModelsPublished,
				Note:             "42.5 cr/s. " + newModelsPublishedSource,
			},
		},
		Sound: map[string]RatePoint{
			"720p": {
				CreditsPerSecond: 28.5,
				Provenance:       ProvenanceReceipt,
				PricedAt:         newModels30sMeasured,
				Note:             "MEASURED 2026-10-28: scripts/kie/measure-price.mjs, kling-4.0/keyframe-to-video 30s 720p, task 2bb08beb40b26edeb65bd3a7749b5c99 -- 855 credits = 28.5 cr/s, the published rate exactly.",
			},
			"1080p": {
				CreditsPerSecond: 42.5,
				Provenance:       ProvenancePublished,
				PricedAt:         newModelsPublished,
				Note:             "42.5 cr/s. " + newModelsPublishedSource,
			},
		},
	},
	// One price with or without sound: kie takes no sound input here. 720p is
	// a receipt (task c8b025db, 2026-10-30); 1080p is still published only.
	"kling-4.0-reference": {
		Silent: map[string]RatePoint{
			"720p":  {CreditsPerSecond: 28.5, Provenance: ProvenanceReceipt, PricedAt: kling4RefMeasured, Note: kling4RefMeasuredNote},
			"1080p": {CreditsPerSecond: 42.5, Provenance: ProvenancePublished, PricedAt: kling4RefPublished, Note: "42.5 cr/s, no video input. " + kling4RefPublishedSource},
		},
		Sound: map[string]RatePoint{
			"720p":  {CreditsPerSecond: 28.5, Provenance: ProvenanceReceipt, PricedAt: kling4RefMeasured, Note: kling4RefMeasuredNote},
			"1080p": {CreditsPerSecond: 42.5, Provenance: ProvenancePublished, PricedAt: kling4RefPublished, Note: "42.5 cr/s, no video input. " + kling4RefPublishedSource},
		},
	},
	"wan-3.0": {
		Sound: map[string]RatePoint{
			"480P": {
				CreditsPerSecond: 8,
				Provenance:       ProvenanceReceipt,
				PricedAt:         newModels30sMeasured,
				Note:             "MEASURED 2026-10-28: scripts/kie/measure-price.mjs, wan/3-0-video 30s 480P audio on, task 4196d7d8aca2eec6e9fde996c6d40124 -- 240 credits = 8 cr/s, the published rate exactly.",
			},
			"720P": {
				CreditsPerSecond: 16,
				Provenance:       ProvenancePublished,
				PricedAt:         newModelsPublished,
				Note:             "16 cr/s. " + newModelsPublishedSource,
			},
			"1080P": {
				CreditsPerSecond: 32,
				Provenance:       ProvenancePublished,
				PricedAt:         newModelsPublished,
				Note:             "32 cr/s. " + newModelsPublishedSource,
			},
		},
		Silent: map[string]RatePoint{},
	},
}

// rateFor is the rate for one model/resolution/sound combination, or
// ok=false when nobody has priced it. Mirrors web/lib/kie/rates.ts's
// rateFor: no silent fallback when withSound is true and the model has no
// sound table — a caller asking for the sound rate of a silent-only model
// has a bug, and answering with the silent rate would hide it.
func rateFor(modelID, resolution string, withSound bool) (RatePoint, bool) {
	rates, ok := Rates[modelID]
	if !ok {
		return RatePoint{}, false
	}
	if withSound {
		if rates.Sound == nil {
			return RatePoint{}, false
		}
		rp, ok := rates.Sound[resolution]
		return rp, ok
	}
	rp, ok := rates.Silent[resolution]
	return rp, ok
}

// ---------------------------------------------------------------------------
// Descriptor — model shape and request-building
// ---------------------------------------------------------------------------

// Descriptor is everything the worker needs to know about one kie video
// model: its identity, the shape of a render request, and how to turn a
// SubmitRequest into kie's own `input` object.
type Descriptor struct {
	// ID is the stable identifier persisted in projects.render_settings.model
	// and this package's own Rates table key.
	ID string
	// Label is the human name; mirrored in web/lib/kie/models.ts.
	Label string
	// KieModelID is the string kie itself expects in createTask's "model"
	// field on the wire. Three different vendor-naming conventions coexist
	// here (see BuildInput's doc comments below for each): Seedance's
	// `owner/name` with dashes, Kling's `version/media-type`, Hailuo's
	// `owner/model-shape`. There is no formula deriving one from another,
	// which is why this is a literal field rather than computed from ID.
	KieModelID string

	DefaultResolution string
	// AllowedResolutions uses kie's OWN spelling for each model, because the
	// value goes back out on the wire in Seedance's `resolution` field and
	// kie validates it as an enum.
	//
	// This comment used to claim Seedance's were capitalised — "480P",
	// "720P", "1080P" — and that Kling's lowercase "1080p" was the odd one
	// out. That was a guess written as a fact, and the first real 480P
	// render died on it: code=500, "resolution is not within the range of
	// allowed options". kie's docs for bytedance/seedance-2-5 spell all
	// three LOWERCASE. Hailuo's "768P" is left as it was — nothing has
	// tested it, and changing it on the strength of a different model's
	// docs would repeat exactly the mistake this paragraph is correcting.
	AllowedResolutions []string
	// AllowedDurationsS is whole seconds kie accepts. Not a range for every
	// model — Hailuo genuinely offers exactly two values, 6 and 10.
	AllowedDurationsS []int
	// AllowedFPS/DefaultFPS/MaxDurationSByFPS exist for the render gate's
	// UI and RenderSettingsSchema's validation, and to keep
	// render_settings.fps meaningful even though — see SupportsFPSInput —
	// no kie model actually takes an fps input today. Every current
	// descriptor delivers at a fixed 24fps regardless of what's sent.
	AllowedFPS        []int
	DefaultFPS        int
	MaxDurationSByFPS map[int]int
	// AspectRatio is the default aspect_ratio input; "" for a model with no
	// such input (Hailuo has none).
	AspectRatio string
	// AllowedAspectRatios are the ratios an operator may pick for this model;
	// nil means AspectRatio is fixed (Gemini, Hailuo).
	AllowedAspectRatios []string
	// SupportsGenerateAudio is true when the model takes a generate_audio-
	// shaped boolean at all — only Seedance today (kie's Kling takes
	// `sound` instead, driven by NativeAudio's branch in PickModel, and
	// Hailuo has no audio input of any kind).
	SupportsGenerateAudio bool

	// SupportsRoleReferences is true when this model reads "@image1" in the
	// prompt as "the first entry of the reference array".
	//
	// FALSE MEANS THE '@' IS A HARD ERROR, not merely ignored. Kling treats
	// any "@xxx" as a ROLE reference and refuses the whole submission unless
	// a kling_elements array accompanies it:
	//
	//   code=422 "kling_elements is required when prompt contains role
	//   references like @element_dog."
	//
	// Observed in production 2026-09-11 on "make the @dog dance", three
	// times in a row, each time after the operator pressed Try again. The
	// '@image1' in that payload was written by OUR OWN bindUITags, not by
	// the operator — it binds a tag to its ordinal, which is exactly right
	// for Seedance and is the thing Kling rejects.
	SupportsRoleReferences bool
	// SupportsFPSInput is true when the model takes an fps input on the
	// wire. False for every descriptor in this file today — kept as an
	// explicit field, not inferred from a non-empty AllowedFPS (which is
	// also the render gate's UI list and must stay non-empty regardless),
	// for the day a fourth kie model actually takes one.
	SupportsFPSInput bool
	// DurationSendAsString sends kie's `duration` field as a JSON STRING
	// rather than a number.
	//
	// TRUE FOR HAILUO, UNPROVEN FOR SEEDANCE, and this comment used to claim
	// both were "discovered independently of each other on kie's live API".
	// Only one of them was:
	//
	//   Hailuo — hailuoInput's own comment records a MEASURED call against
	//   kie on 2026-08-31 that produced a billed 10s render at 90 credits.
	//   That is a receipt. It stands.
	//
	//   Seedance — traced to 3d6fe0f ("Wire Seedance 2.5, with both its
	//   resolutions measured"), which predates kie entirely and is a FAL
	//   commit: "2.5 declares `duration` as an enum of strings where every
	//   earlier model declares an integer, so an int is a 422". That was
	//   fal's schema endpoint. The flag was carried over to kie unexamined,
	//   and seedanceInput's own comment has said "unverified" the whole
	//   time — the two comments contradicted each other in one file.
	//
	// kie's published schema for `bytedance/seedance-2-5` types `duration`
	// as an integer. NOT changed on that basis: kie accepts unknown and
	// wrongly-typed fields, returns 200 and bills the render, so a doc-led
	// guess costs a paid render either way. client.go's logSubmittedInput
	// now records what is actually sent, so the next real render settles it.
	DurationSendAsString bool
	// NativeAudio is true only for Kling: PickModel reads it as "route
	// through nativeAudioModel, and never generalize to non-talking-head
	// scenes unless the project explicitly selected this model" — see
	// PickModel's own doc comment.
	NativeAudio bool
	// BuildInput turns one SubmitRequest into kie's ENTIRE `input` object
	// for this model. A function per model, not one builder with per-model
	// `if`s, because Seedance and Kling do not merely differ in which
	// optional fields are present — they use different key names for the
	// same concept (`resolution` vs `mode`, `generate_audio` vs `sound`)
	// and Kling carries a field Seedance has no equivalent of at all
	// (`multi_shots`). See each function's own doc comment for exactly
	// what it sends and why.
	BuildInput func(SubmitRequest) map[string]any
}

// kling3Pro is the talking-head / native-audio (lip-synced) route, and the
// only model here with a sound-on rate.
//
// MODE MAPPING (see klingInput): kie's Kling names its resolution tiers
// std/pro/4K rather than a pixel height. "1080p" -> "pro" and, as of
// 2026-09-10, "720p" -> "std" are the two reachable mappings
// (AllowedResolutions below carries both). std -> 720p is confirmed, not
// just assumed from the shared name: both std receipts (klingStdMeasured,
// klingStdSilentMeasured above) delivered 1280x720. pro -> 1080p still
// rests on nothing more than the shared name — see klingInput's own
// comment for exactly what that argument does and does not establish.
//
// TWO TIERS since 2026-09-10: std/720p (20 cr/s with sound, a receipt —
// see Rates above) joined pro/1080p (27) once /ugc needed a cheaper Kling
// render. DefaultResolution stays pro/1080p — that is the scripted
// pipeline's default and does not change; /ugc's own default is std/720p,
// chosen in web/lib/ugc-options.ts by the cheapest offerable tier, not by
// this field. The id stays "kling-3.0-pro" regardless of which mode a
// given render uses — it is persisted in render_settings.model and in
// every run already on record, and renaming it would strand both; "Pro"
// left the LABEL, not the id.
var kling3Pro = Descriptor{
	ID:                    "kling-3.0-pro",
	Label:                 "Kling 3.0 (native audio)",
	KieModelID:            "kling-3.0/video",
	DefaultResolution:     "1080p",
	AllowedResolutions:    []string{"720p", "1080p"},
	AllowedDurationsS:     []int{3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15},
	AllowedFPS:            []int{24},
	DefaultFPS:            24,
	MaxDurationSByFPS:     map[int]int{},
	AspectRatio:           "9:16",
	AllowedAspectRatios:   VideoAspectRatios,
	SupportsGenerateAudio: false,
	SupportsFPSInput:      false,
	DurationSendAsString:  false,
	NativeAudio:           true,
	// Kling refuses any '@' in the prompt without kling_elements, which this
	// product does not send. See SupportsRoleReferences.
	SupportsRoleReferences: false,
	BuildInput:             klingInput,
}

// hailuo2_3Pro is the cheapest second available on this account, and
// unusable for the four-second workflow: kie takes 6 or 10 seconds only for
// this model, not a range.
var hailuo2_3Pro = Descriptor{
	ID:                     "hailuo-2.3-pro",
	Label:                  "Hailuo 2.3 Pro",
	KieModelID:             "hailuo/2-3-image-to-video-pro",
	DefaultResolution:      "768P",
	AllowedResolutions:     []string{"768P"},
	AllowedDurationsS:      []int{6, 10},
	AllowedFPS:             []int{24},
	DefaultFPS:             24,
	MaxDurationSByFPS:      map[int]int{},
	SupportsGenerateAudio:  false,
	SupportsFPSInput:       false,
	DurationSendAsString:   true,
	NativeAudio:            false,
	SupportsRoleReferences: true, // Unchanged from before this flag existed; no receipt either way.
	BuildInput:             hailuoInput,
}

// geminiOmniVideo deliberately has its own builder. It is reference-shaped
// like Seedance, but its field names and its video object are different.
var geminiOmniVideo = Descriptor{
	ID:                     "gemini-omni-video",
	Label:                  "Gemini Omni Video",
	KieModelID:             "gemini-omni-video",
	DefaultResolution:      "720p",
	AllowedResolutions:     []string{"360p", "720p", "1080p", "4k"},
	AllowedDurationsS:      []int{4, 6, 8, 10},
	AllowedFPS:             []int{24},
	DefaultFPS:             24,
	MaxDurationSByFPS:      map[int]int{},
	AspectRatio:            "9:16",
	SupportsGenerateAudio:  false,
	SupportsFPSInput:       false,
	DurationSendAsString:   true,
	NativeAudio:            false,
	SupportsRoleReferences: true,
	BuildInput:             geminiOmniInput,
}

var geminiOmni12 = Descriptor{
	ID:                     "gemini-omni-1.2",
	Label:                  "Gemini Omni 1.2 Flash",
	KieModelID:             "google/gemini-omni-flash-1-2",
	DefaultResolution:      "720p",
	AllowedResolutions:     []string{"360p", "720p", "1080p", "4k"},
	AllowedDurationsS:      []int{3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15},
	AllowedFPS:             []int{24},
	DefaultFPS:             24,
	MaxDurationSByFPS:      map[int]int{},
	AspectRatio:            "9:16",
	AllowedAspectRatios:    []string{"9:16", "16:9"},
	SupportsGenerateAudio:  false,
	SupportsFPSInput:       false,
	DurationSendAsString:   false,
	NativeAudio:            false,
	SupportsRoleReferences: false,
	BuildInput:             geminiOmni12Input,
}

// seedance25 is the general-purpose default. No longer the only model
// priced at more than one resolution (Kling now has two priced tiers, and
// seedance2/seedance2Fast below list several each) — but it has been
// priced (as "published", unpaid) at all three of kie's tiers since
// 2026-08-31, instead of only the two anyone had been billed for. See
// Rates["seedance-2.5"] above for the per-tier provenance; an
// operator-facing UI is what owes the "unpaid" label
// (web/lib/kie/rates.ts's isUnpaidRate), not this package.
var seedance25 = Descriptor{
	ID:                    "seedance-2.5",
	Label:                 "Seedance 2.5 (native audio)",
	KieModelID:            "bytedance/seedance-2-5",
	DefaultResolution:     "480p",
	AllowedResolutions:    []string{"480p", "720p", "1080p"},
	AllowedDurationsS:     []int{4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30},
	AllowedFPS:            []int{24},
	DefaultFPS:            24,
	MaxDurationSByFPS:     map[int]int{},
	AspectRatio:           "9:16",
	AllowedAspectRatios:   VideoAspectRatios,
	SupportsGenerateAudio: true,
	SupportsFPSInput:      false,
	// FALSE, because kie's schema for bytedance/seedance-2-5 types `duration`
	// as an integer. This was true on the same guess that capitalised the
	// resolutions, and client.go's logSubmittedInput comment already listed
	// it as open. It is no longer open.
	DurationSendAsString:   false,
	NativeAudio:            false,
	SupportsRoleReferences: true, // Seedance reads @imageN as reference_image_urls[N-1].
	BuildInput:             seedanceInput,
}

const BytePlusSeedance25ID = "seedance-2.5-byteplus"

var seedance25BytePlus = func() Descriptor {
	d := seedance25
	d.ID = BytePlusSeedance25ID
	d.Label = "Seedance 2.5 (BytePlus ModelArk)"
	return d
}()

// seedance2Fast is the cheap tier of ByteDance's 2.0 line, added because the
// editors asked for the same clip for less money rather than for anything new.
//
// SAME WIRE SHAPE as 2.5 — it reuses seedanceInput unchanged, taking
// reference_image_urls, reference_audio_urls, generate_audio, resolution,
// aspect_ratio and an integer duration under exactly those names (kie's
// schema for bytedance/seedance-2-fast, read 2026-09-04).
//
// WHERE IT IS NARROWER, and both matter:
//
//	Resolution stops at 720p. There is no 1080p and no 4k, unlike 2.5 and
//	unlike plain seedance-2.
//
//	Audio references are 3 files of 2-15s, against 2.5's 10 files of 2-30s.
//	web/lib/file-type.ts's MIN/MAX_REFERENCE_AUDIO_SECONDS is a single
//	global pair, so the picker's advisory length warning is 2.5's window and
//	is WRONG FOR THIS MODEL by 15 seconds. It warns rather than blocks, so
//	nothing is refused locally that kie would have taken — but a 25-second
//	clip will pass our check and be refused by kie after submission. Making
//	that limit per-model is the follow-up this model earns; it is not done
//	here because it is a different change from adding a descriptor.
var seedance2Fast = Descriptor{
	ID:                 "seedance-2-fast",
	Label:              "Seedance 2.0 Fast (cheapest)",
	KieModelID:         "bytedance/seedance-2-fast",
	DefaultResolution:  "480p",
	AllowedResolutions: []string{"480p", "720p"},
	// 4-15, the same span 2.5 offers. kie also documents -1 for "let the
	// model decide" and it is deliberately not offered: a duration nobody
	// chose is a duration nobody can price before pressing the button.
	AllowedDurationsS:     []int{4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15},
	AllowedFPS:            []int{24},
	DefaultFPS:            24,
	MaxDurationSByFPS:     map[int]int{},
	AspectRatio:           "9:16",
	AllowedAspectRatios:   VideoAspectRatios,
	SupportsGenerateAudio: true,
	SupportsFPSInput:      false,
	// Integer, per kie's schema — the same finding that settled 2.5's.
	DurationSendAsString:   false,
	NativeAudio:            false,
	SupportsRoleReferences: true, // Seedance reads @imageN as reference_image_urls[N-1].
	BuildInput:             seedanceInput,
}

// seedance2 is ByteDance's 2.0 proper: cheaper than 2.5 at every tier, and
// the only model here that reaches 4K.
//
// Same wire shape as the other two Seedances, so it reuses seedanceInput
// unchanged. Its audio window is 2.0's, not 2.5's — 3 files of 2-15s — which
// is the same caveat seedance2Fast carries.
//
// 4K IS PRICED BUT NOT OFFERED (see Rates above): 208 cr/s is $8.32 for a 4s
// clip. AllowedResolutions stops at 1080p so the picker cannot reach it.
var seedance2 = Descriptor{
	ID:                     "seedance-2",
	Label:                  "Seedance 2.0",
	KieModelID:             "bytedance/seedance-2",
	DefaultResolution:      "480p",
	AllowedResolutions:     []string{"480p", "720p", "1080p"},
	AllowedDurationsS:      []int{4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15},
	AllowedFPS:             []int{24},
	DefaultFPS:             24,
	MaxDurationSByFPS:      map[int]int{},
	AspectRatio:            "9:16",
	AllowedAspectRatios:    VideoAspectRatios,
	SupportsGenerateAudio:  true,
	SupportsFPSInput:       false,
	DurationSendAsString:   false,
	NativeAudio:            false,
	SupportsRoleReferences: true,
	BuildInput:             seedanceInput,
}

// Descriptors is every model kie serves — the same five, and the same
// order, as web/lib/kie/models.ts's KIE_MODELS.
// seedance2Mini is ByteDance's smallest 2.0 tier
// (docs.kie.ai/market/bytedance/seedance-2-mini): same wire shape as the
// other Seedances, so it reuses seedanceInput. kie takes at most 9 reference
// images here, against the References box's 10.
//
// ponytail: a 10th image is refused by kie (unbilled), not trimmed here —
// trimming would drop a reference the operator chose without saying so.
var seedance2Mini = Descriptor{
	ID:                     "seedance-2-mini",
	Label:                  "Seedance 2.0 Mini",
	KieModelID:             "bytedance/seedance-2-mini",
	DefaultResolution:      "480p",
	AllowedResolutions:     []string{"480p", "720p"},
	AllowedDurationsS:      []int{4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15},
	AllowedFPS:             []int{24},
	DefaultFPS:             24,
	MaxDurationSByFPS:      map[int]int{},
	AspectRatio:            "9:16",
	AllowedAspectRatios:    VideoAspectRatios,
	SupportsGenerateAudio:  true,
	SupportsFPSInput:       false,
	DurationSendAsString:   false,
	NativeAudio:            false,
	SupportsRoleReferences: true,
	BuildInput:             seedanceInput,
}

// kling4 is Kling 4.0's keyframe-to-video endpoint
// (docs.kie.ai/market/kling/v4-keyframe-to-video). NativeAudio for the
// Kling-family path PickModel already takes — is_talking_head picks the
// tier — though kie takes no sound input and prices both tiers the same.
// Any undeclared '@' in the prompt is a parameter error, like Kling 3.0.
var kling4 = Descriptor{
	ID:                     "kling-4.0",
	Label:                  "Kling 4.0",
	KieModelID:             "kling-4.0/keyframe-to-video",
	DefaultResolution:      "720p",
	AllowedResolutions:     []string{"720p", "1080p"},
	AllowedDurationsS:      []int{3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30},
	AllowedFPS:             []int{24},
	DefaultFPS:             24,
	MaxDurationSByFPS:      map[int]int{},
	AspectRatio:            "9:16",
	AllowedAspectRatios:    VideoAspectRatios,
	SupportsGenerateAudio:  false,
	SupportsFPSInput:       false,
	DurationSendAsString:   false,
	NativeAudio:            true,
	SupportsRoleReferences: false,
	BuildInput:             kling4Input,
}

// kling4Ref is Kling 4.0's reference-to-video endpoint
// (docs.kie.ai/market/kling/v4-reference-to-video): @tags instead of
// start/end frames. Seedance-shaped for the rest of the pipeline -- role
// references on, no NativeAudio -- because kie renders sound unasked and
// takes no flag for it.
var kling4Ref = Descriptor{
	ID:                     "kling-4.0-reference",
	Label:                  "Kling 4.0 Reference",
	KieModelID:             "kling-4.0/reference-to-video",
	DefaultResolution:      "720p",
	AllowedResolutions:     []string{"720p", "1080p"},
	AllowedDurationsS:      []int{3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30},
	AllowedFPS:             []int{24},
	DefaultFPS:             24,
	MaxDurationSByFPS:      map[int]int{},
	AspectRatio:            "9:16",
	AllowedAspectRatios:    VideoAspectRatios,
	SupportsGenerateAudio:  false,
	SupportsFPSInput:       false,
	DurationSendAsString:   false,
	NativeAudio:            false,
	SupportsRoleReferences: true,
	BuildInput:             kling4RefInput,
}

// wan3 is Wan 3.0 (docs.kie.ai/market/wan/3-0-video). Uppercase resolutions
// and an `audio` flag instead of generate_audio; otherwise Seedance-shaped
// reference arrays. Role references off: kie names references Image1,
// Image2, … and nothing here has proven it reads "@image1".
var wan3 = Descriptor{
	ID:                     "wan-3.0",
	Label:                  "Wan 3.0",
	KieModelID:             "wan/3-0-video",
	DefaultResolution:      "480P",
	AllowedResolutions:     []string{"480P", "720P", "1080P"},
	AllowedDurationsS:      []int{4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30},
	AllowedFPS:             []int{24},
	DefaultFPS:             24,
	MaxDurationSByFPS:      map[int]int{},
	AspectRatio:            "9:16",
	AllowedAspectRatios:    VideoAspectRatios,
	SupportsGenerateAudio:  true,
	SupportsFPSInput:       false,
	DurationSendAsString:   false,
	NativeAudio:            false,
	SupportsRoleReferences: false,
	BuildInput:             wanInput,
}

// VideoAspectRatios is what /ugc offers, mirrored by web/lib/kie/models.ts's
// VIDEO_ASPECT_RATIOS. Every model listing it accepts all three on kie
// (docs read 2026-10-27); media.Normalize crops to the matching frame.
var VideoAspectRatios = []string{"9:16", "16:9", "1:1"}

var Descriptors = []Descriptor{seedance25, seedance25BytePlus, seedance2, seedance2Fast, seedance2Mini, kling3Pro, kling4, kling4Ref, hailuo2_3Pro, wan3, geminiOmniVideo, geminiOmni12}

// DefaultModelID is the model a project gets when render_settings says
// nothing: the general-purpose, non-native-audio default, same role
// Seedance 2.5 has held since fal's LTX23Fast was disabled.
const DefaultModelID = "seedance-2.5"

// DescriptorByID refuses unknown selections. A failed scene is preferable to
// submitting and billing a different model than the operator chose.
func DescriptorByID(id string) (Descriptor, bool) {
	for _, d := range Descriptors {
		if d.ID == id {
			return d, true
		}
	}
	return Descriptor{}, false
}

// DescriptorByKieModelID looks a model up by the wire string kie itself
// uses (Descriptor.KieModelID) — what Client.Submit has on hand in a
// SubmitRequest, which never carries the product id.
func DescriptorByKieModelID(kieModelID string) (Descriptor, bool) {
	for _, d := range Descriptors {
		if d.KieModelID == kieModelID {
			return d, true
		}
	}
	return Descriptor{}, false
}

// canonicalResolution matches `want` against `allowed` ignoring case and
// returns the allowed list's own spelling — the one kie's enum accepts.
func canonicalResolution(allowed []string, want string) (string, bool) {
	for _, a := range allowed {
		if strings.EqualFold(a, want) {
			return a, true
		}
	}
	return "", false
}

func containsString(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}

// MaxDurationForFPS reports the longest clip length this fps is legal for
// and whether any such limit exists at all.
func MaxDurationForFPS(d Descriptor, fps int) (int, bool) {
	max, ok := d.MaxDurationSByFPS[fps]
	return max, ok
}

// ClampFPSForDuration lowers fps to the model's default when the requested
// value is illegal for a clip of this length. A no-op for every descriptor
// in this file today (MaxDurationSByFPS is empty on all three — that
// constraint was LTX's, and LTX is gone), kept because RenderSettings still
// carries an fps a future model could legitimately constrain, and because
// dispatch.go calling this unconditionally is simpler than a call site that
// has to know which models need it.
func ClampFPSForDuration(d Descriptor, fps int, durationS float64) int {
	if max, ok := MaxDurationForFPS(d, fps); ok && durationS > float64(max) {
		return d.DefaultFPS
	}
	return fps
}

// ---------------------------------------------------------------------------
// Render settings (projects.render_settings jsonb)
// ---------------------------------------------------------------------------

// RenderSettings mirrors web/lib/models.ts's RenderSettings — the
// per-project choice persisted by 0012_render_settings.sql.
type RenderSettings struct {
	Model      string `json:"model"`
	Resolution string `json:"resolution"`
	FPS        int    `json:"fps"`
	// Voice is a Gemini preset voice name ("achernar"), sent as audio_ids.
	// Empty for every other model and for "let Gemini pick".
	Voice string `json:"voice"`
	// AspectRatio is the operator's choice from VideoAspectRatios; empty means
	// the model's own default (9:16 for every model that takes one).
	AspectRatio string `json:"aspect_ratio"`
	// Quality is the editor's re-encode pick in /ugc ("standard", "high", "max");
	// empty means standard. media.CRFFor maps it. No vendor sees it, no price moves.
	Quality string `json:"quality"`
}

// DefaultRenderSettings is what an empty `{}` means. The column's SQL
// default is `{}` rather than a populated object precisely so that new and
// existing rows both resolve through here, leaving one definition of the
// default per language instead of two that can disagree.
func DefaultRenderSettings() RenderSettings {
	return RenderSettings{
		Model:      seedance25.ID,
		Resolution: seedance25.DefaultResolution,
		FPS:        seedance25.DefaultFPS,
	}
}

// ParseRenderSettings defaults absent settings for legacy projects, but refuses
// malformed settings and explicit unknown models: neither authorizes a substitute.
func ParseRenderSettings(raw []byte) (RenderSettings, error) {
	settings := DefaultRenderSettings()
	if len(raw) == 0 {
		return settings, nil
	}

	var parsed struct {
		Model       *string `json:"model"`
		Resolution  *string `json:"resolution"`
		FPS         *int    `json:"fps"`
		Voice       *string `json:"voice"`
		AspectRatio *string `json:"aspect_ratio"`
		Quality     *string `json:"quality"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return RenderSettings{}, fmt.Errorf("invalid render settings: %w", err)
	}

	model := seedance25
	if parsed.Model != nil {
		var ok bool
		model, ok = DescriptorByID(*parsed.Model)
		if !ok {
			return RenderSettings{Model: *parsed.Model}, fmt.Errorf("unknown render model %q", *parsed.Model)
		}
	}
	settings.Model = model.ID
	settings.Resolution = model.DefaultResolution
	settings.FPS = model.DefaultFPS

	// CASE-INSENSITIVE, resolving to the descriptor's spelling rather than the
	// caller's. Overrides written before the Seedance resolutions were
	// corrected are stored as "480P" and would otherwise stop matching the
	// moment they were fixed — the scene would fall back to the default
	// instead of honouring a setting the operator chose. What goes on the
	// wire is always AllowedResolutions' own string, never the stored one.
	if parsed.Resolution != nil {
		if canonical, ok := canonicalResolution(model.AllowedResolutions, *parsed.Resolution); ok {
			settings.Resolution = canonical
		}
	}
	if parsed.FPS != nil {
		for _, allowed := range model.AllowedFPS {
			if allowed == *parsed.FPS {
				settings.FPS = allowed
				break
			}
		}
	}
	if parsed.Voice != nil && model.ID == "gemini-omni-video" {
		settings.Voice = *parsed.Voice
	}
	// A ratio the model does not take is dropped, not refused: the model's
	// own AspectRatio applies, the same fallback resolution gets.
	if parsed.AspectRatio != nil && containsString(model.AllowedAspectRatios, *parsed.AspectRatio) {
		settings.AspectRatio = *parsed.AspectRatio
	}
	// An unknown quality is dropped to standard, like an untaken ratio above.
	if parsed.Quality != nil && containsString([]string{"standard", "high", "max"}, *parsed.Quality) {
		settings.Quality = *parsed.Quality
	}
	return settings, nil
}

// aspectRatioFor is the ratio a render is submitted (and normalized) at:
// the operator's choice when the model takes it, else the model's default.
func aspectRatioFor(d Descriptor, settings RenderSettings) string {
	if containsString(d.AllowedAspectRatios, settings.AspectRatio) {
		return settings.AspectRatio
	}
	return d.AspectRatio
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

// Model is a resolved routing decision: which kie model to submit to and
// the model-specific inputs that go into the request.
type Model struct {
	// ID is Descriptor.ID — this package's own Rates table key, and what
	// EstimateCost prices against.
	ID string
	// KieModelID is Descriptor.KieModelID — the wire string, and what
	// store.Run.Model records (see dispatch.go/ingest.go).
	KieModelID string

	Resolution  string
	FPS         int
	AspectRatio string

	DurationSendAsString bool
	GenerateAudio        *bool
	HasAudio             bool

	// SupportsRoleReferences is Descriptor.SupportsRoleReferences, carried
	// to submit time because loop.promptForScene needs it and holds a Model
	// rather than a Descriptor. Kling refuses any '@' in the prompt without
	// a kling_elements array; Seedance reads "@imageN" as an index into
	// reference_image_urls.
	SupportsRoleReferences bool

	// Substituted/SubstitutionReason no longer exist here. The only case
	// that ever produced them — PickModel refusing an Enabled: false
	// descriptor and swapping in the safe default — has no descriptors
	// left to refuse: every kie.Descriptors entry is always selectable.
	// See this file's own header comment.
}

// klingInput builds kie's Kling 3.0 input body. MEASURED against the live
// API on 2026-08-29 — probed until kie stopped rejecting the request, not
// reconstructed from kie's docs. The minimal request that was accepted:
//
//	{"model":"kling-3.0/video",
//	 "input":{"mode":"pro","multi_shots":false,"prompt":"...",
//	          "sound":true,"duration":6,"aspect_ratio":"9:16",
//	          "image_urls":["..."]}}
//
// Three findings, not guesses:
//
//   - `mode` carries resolution — std | pro | 4K — there is no `resolution`
//     key on this model at all.
//   - `sound` is the audio flag — there is no `generate_audio` key.
//   - `multi_shots` is REQUIRED. Omitting it returns
//     `422 multi_shots cannot be empty`, despite kie's own docs calling it
//     optional. Always false: this pipeline renders one shot per scene.
//
// `mode: "pro"` maps kling3Pro's own "1080p" resolution. There is no live
// probe confirming `pro` decodes to 1080p specifically — see
// kling3Pro's own doc comment for exactly what this naming argument does
// and does not establish.
//
// `aspect_ratio` comes off the request (klingAspectRatio). kie documents it
// as honoured only for text-to-video: with a start frame the output follows
// the frame's shape, and media.Normalize crops it to the chosen ratio.
//
// `sound` comes off req.HasAudio, which dispatch.go fills from
// Model.HasAudio (nativeAudioModel below) — see that function's doc
// comment for why this is NOT hardcoded true.
//
// `image_urls` TAKES ONE OR TWO ITEMS, not always one — the probe above
// only ever exercised the one-item case, and this function used to hardcode
// exactly that. kie documents a second item as a last frame: 1 item
// conditions the whole clip on a single frame, 2 items condition it on a
// first and a last. /ugc's Kling mode is what actually sends two.
// klingAspectRatio defaults to 9:16 for a request built without one.
func klingAspectRatio(req SubmitRequest) string {
	if req.AspectRatio != "" {
		return req.AspectRatio
	}
	return "9:16"
}

func klingInput(req SubmitRequest) map[string]any {
	// kie's Kling names its resolution tiers `mode`, not `resolution`, and
	// takes std / pro / 4K rather than a pixel height. Unknown resolutions
	// fall back to "pro", not "std": a wrong tier must overstate, never
	// understate, the same rule every rate table in this file follows.
	mode := "pro"
	switch req.Resolution {
	case "720p":
		mode = "std"
	case "2160p":
		mode = "4K"
	}

	// UP TO TWO FRAMES, not one. kie documents image_urls as taking a
	// single item (the whole clip conditions on it) OR two (a first frame
	// and a last frame) — this used to hardcode `[]string{req.ImageURL}`,
	// which is exactly the one-item case and the only one /ugc's Kling mode
	// ever needed until it grew a Start/End frame pair of its own.
	//
	// req.ImageURLs is scene_references (0071) resolved and signed in
	// ordinal order — see dispatch.go's own comment on that slice. For a
	// Kling scene ordinal 1 is the start frame and ordinal 2, when the
	// operator picked one, is the end frame; there are never any other
	// image references on a Kling scene (actions/ugc.ts's generateClip
	// writes nothing else for this model), so the slice is already exactly
	// the one or two frames kie wants, in the right order.
	//
	// Falls back to the single ImageURL when ImageURLs is empty, same rule
	// seedanceInput follows below: every caller predating scene_references
	// sets only the one field.
	images := req.ImageURLs
	if len(images) == 0 && req.ImageURL != "" {
		images = []string{req.ImageURL}
	}
	// NEVER MORE THAN TWO. A third frame is not a shape kie has ever been
	// asked about here, and sending one on a guess is how "up to two" turns
	// into "however many happened to be in the slice".
	if len(images) > 2 {
		images = images[:2]
	}

	input := map[string]any{
		"prompt":       req.Prompt,
		"mode":         mode,
		"sound":        req.HasAudio,
		"multi_shots":  false,
		"aspect_ratio": klingAspectRatio(req),
	}
	// Omitted, not sent as [], when there is no frame at all. /ugc refuses
	// a Kling clip without a start frame before it is ever queued, so this
	// is only reachable by an older scene; an empty array is a shape kie
	// never documented, and leaving the key out is plain text-to-video.
	if len(images) > 0 {
		input["image_urls"] = images
	}
	if req.DurationSeconds > 0 {
		// A bare JSON number in the measured request — unlike Seedance and
		// Hailuo below, this model has no string-duration quirk.
		input["duration"] = req.DurationSeconds
	}
	return input
}

// hailuoInput builds kie's Hailuo 2.3 input body. MEASURED against the live
// API on 2026-08-31: this exact shape produced a billed 10s render (90
// credits, $0.045/s at 768P).
//
// Two things it does NOT share with seedanceInput below:
//
//	image_url  — SINGULAR. Sending the array form here is silently
//	             dropped, so the render comes back unconditioned on the
//	             reference frame: a different person, with the request
//	             still billed.
//
//	duration   — a STRING ("10"), not a number, same trap Seedance has,
//	             arrived at independently for a different model.
//
// No fps input and no audio input: kie exposes neither on this model.
// kling4Input builds kling-4.0/keyframe-to-video's input. kie rejects any
// field it does not list, so this sends only documented ones: the first
// image is the start frame, the second the end frame. No sound field exists.
func kling4Input(req SubmitRequest) map[string]any {
	images := req.ImageURLs
	if len(images) == 0 && req.ImageURL != "" {
		images = []string{req.ImageURL}
	}
	input := map[string]any{
		"prompt":       req.Prompt,
		"resolution":   req.Resolution,
		"aspect_ratio": klingAspectRatio(req),
	}
	if len(images) > 0 {
		input["first_frame_url"] = images[0]
	}
	if len(images) > 1 {
		input["last_frame_url"] = images[1]
	}
	if req.DurationSeconds > 0 {
		input["duration"] = int(req.DurationSeconds)
	}
	return input
}

// seedanceImageTag is the "@image1" bindUITags writes.
var seedanceImageTag = regexp.MustCompile(`@image(\d+)\b`)

// kling4RefInput builds kling-4.0/reference-to-video's input. kie rejects any
// field it does not list. Images go in image_urls and are named "@image_1",
// so bindUITags' "@image1" is respelled. Every '@' must name something sent,
// so no video or voice goes out: the web refuses both for this model.
func kling4RefInput(req SubmitRequest) map[string]any {
	images := req.ImageURLs
	if len(images) == 0 && req.ImageURL != "" {
		images = []string{req.ImageURL}
	}
	input := map[string]any{
		"prompt":       seedanceImageTag.ReplaceAllString(req.Prompt, "@image_$1"),
		"resolution":   req.Resolution,
		"aspect_ratio": klingAspectRatio(req),
	}
	if len(images) > 0 {
		input["image_urls"] = images
	}
	if req.DurationSeconds > 0 {
		input["duration"] = int(req.DurationSeconds)
	}
	return input
}

func hailuoInput(req SubmitRequest) map[string]any {
	input := map[string]any{
		"prompt":    req.Prompt,
		"image_url": req.ImageURL,
	}
	if req.DurationSeconds > 0 {
		input["duration"] = strconv.FormatFloat(req.DurationSeconds, 'f', -1, 64)
	}
	if req.Resolution != "" {
		input["resolution"] = req.Resolution
	}
	return input
}

// seedanceInput builds kie's Seedance 2.5 input body.
//
// FIELD NAME CHANGED: image_urls -> reference_image_urls. The old name came
// from the fal era and appears NOWHERE in kie's published schema for
// bytedance/seedance-2-5, which names exactly three ways to hand this model a
// picture:
//
//	first_frame_url        the clip literally opens on this image
//	last_frame_url         requires first_frame_url
//	reference_image_urls   up to 30, addressed from the prompt as @image1…
//
// The first two are MUTUALLY EXCLUSIVE with the third, so this is a design
// choice and not merely a rename. reference_image_urls is the one picked,
// because the /ugc prompt editor's whole mechanism is naming references
// inside the prompt — see loop.bindUITags, which rewrites the operator's
// "@lena" into the "@image1" this array is indexed by. first_frame_url gives
// a stronger guarantee for a single reference (the image IS frame zero) but
// there is nothing for a tag to point at, so choosing it would mean deleting
// the tags rather than binding them.
//
// STILL UNVERIFIED, and deliberately so. kie accepts unknown fields, returns
// 200 and bills the render, so neither the old name nor the new one can be
// confirmed by sending it — that is the trap this repo has paid for twice.
// What changed is the evidence: image_urls is absent from the schema for our
// exact model id, and reference_image_urls is in it. That is not proof, but
// it is strictly better odds than the name it replaces, whose only support
// was that createTask did not complain. client.go's logSubmittedInput now
// records what is actually sent, so the next real render settles it.
//
// duration and resolution are LEFT AS THEY ARE for the same reason in the
// other direction: kie's schema types duration as an integer and spells the
// resolution enum lowercase, but both of ours trace to observations someone
// recorded, so changing them on a doc reading alone is a paid coin-flip. See
// Descriptor.DurationSendAsString for what that provenance actually turned
// out to be.
func seedanceInput(req SubmitRequest) map[string]any {
	// EVERY reference, in the order the prompt names them. req.ImageURLs is
	// scene_references (0071) resolved and signed in ordinal order, so
	// element 0 is the "@image1" loop.bindUITags wrote into the prompt.
	//
	// Falls back to the single ImageURL when the slice is empty: every caller
	// predating that table sets only the one field, and a scene with one
	// reference must submit exactly what it always did.
	images := req.ImageURLs
	if len(images) == 0 && req.ImageURL != "" {
		images = []string{req.ImageURL}
	}
	input := map[string]any{
		"prompt": req.Prompt,
	}
	// OMITTED ENTIRELY when there is no reference, rather than sent empty.
	// An empty array is a different statement from an absent key.
	//
	// Both routes send images now. /ugc briefly did not — its references were
	// described into the prompt instead — and the first render showed what
	// prose cannot do: it held the wardrobe and lost the face. See
	// loop/dispatch.go for what that looked like.
	if len(images) > 0 {
		input["reference_image_urls"] = images
	}
	// THE VOICE, and it is a genuinely separate thing from generate_audio
	// below. reference_audio_urls is material the model listens to;
	// generate_audio decides whether the OUTPUT carries sound at all. kie's
	// docs state they operate independently, and this product sets both:
	// generate_audio has been true on every render, and a voice reference is
	// what makes the sound belong to a particular person.
	//
	// Omitted rather than sent empty, same rule as the images above: an empty
	// array is a different statement from an absent key, and only one of them
	// is true when a prompt tagged no voice.
	//
	// The vendor's limits — WAV/MP3, 2-30s each, 15 MB each, 10 files, 30s
	// total — are enforced at upload (web/lib/file-type.ts) and by kie. They
	// are deliberately not re-checked here: a worker that silently dropped an
	// over-long clip would render a scene the operator believed carried a
	// voice, which is worse than kie refusing it out loud.
	if len(req.AudioURLs) > 0 {
		input["reference_audio_urls"] = req.AudioURLs
	}
	// THE ONE THAT CHANGES THE BILL. reference_video_urls is not a third
	// reference like the two above it: per this file's own rate table (see
	// kiePublishedSource and the seedance-2-fast Note below), kie prices a
	// render that carries a video reference as Price x (input + output)
	// instead of Price x output. Every quote (web/lib/spend.ts) and every
	// cap check upstream of this line assumes Price x output — attaching
	// this key is the moment that assumption stops being true, and nobody
	// has a receipt yet for what the input+output figure actually is.
	//
	// Said here, at the call site, because whoever adds a FOURTH reference
	// kind to this function is the person most likely to copy the shape of
	// these three lines without reading this comment — check the rate table
	// before wiring in a new key, not after the invoice arrives.
	//
	// Omitted rather than sent empty, same rule as the two above: an empty
	// array is a different statement from an absent key.
	if len(req.VideoURLs) > 0 {
		input["reference_video_urls"] = req.VideoURLs
	}
	if req.DurationSeconds > 0 {
		if req.DurationSendAsString {
			input["duration"] = strconv.FormatFloat(req.DurationSeconds, 'f', -1, 64)
		} else {
			input["duration"] = req.DurationSeconds
		}
	}
	if req.Resolution != "" {
		input["resolution"] = req.Resolution
	}
	if req.AspectRatio != "" {
		input["aspect_ratio"] = req.AspectRatio
	}
	if req.GenerateAudio != nil {
		input["generate_audio"] = *req.GenerateAudio
	}
	return input
}

// geminiOmniInput builds Gemini Omni Video's documented Kie shape. Audio
// URLs are intentionally not translated: Gemini accepts Kie audio_ids, not
// URLs, and callers must refuse them before a job is submitted.
// wanInput builds wan/3-0-video's input: Seedance's reference arrays, with
// sound sent as `audio` rather than generate_audio.
func wanInput(req SubmitRequest) map[string]any {
	images := req.ImageURLs
	if len(images) == 0 && req.ImageURL != "" {
		images = []string{req.ImageURL}
	}
	input := map[string]any{
		"prompt": req.Prompt,
	}
	if len(images) > 0 {
		input["reference_image_urls"] = images
	}
	if len(req.AudioURLs) > 0 {
		input["reference_audio_urls"] = req.AudioURLs
	}
	if len(req.VideoURLs) > 0 {
		input["reference_video_urls"] = req.VideoURLs
	}
	if req.DurationSeconds > 0 {
		input["duration"] = int(req.DurationSeconds)
	}
	if req.Resolution != "" {
		input["resolution"] = req.Resolution
	}
	if req.AspectRatio != "" {
		input["aspect_ratio"] = req.AspectRatio
	}
	if req.GenerateAudio != nil {
		input["audio"] = *req.GenerateAudio
	}
	return input
}

func geminiOmniInput(req SubmitRequest) map[string]any {
	images := req.ImageURLs
	if len(images) == 0 && req.ImageURL != "" {
		images = []string{req.ImageURL}
	}
	input := map[string]any{
		"prompt":       req.Prompt,
		"duration":     strconv.FormatFloat(req.DurationSeconds, 'f', -1, 64),
		"aspect_ratio": "9:16",
		"resolution":   req.Resolution,
	}
	if len(images) > 0 {
		input["image_urls"] = images
	}
	// kie flags every render that sends audio_ids without an image as a
	// content-policy violation (probed 2026-09-15); the dispatch gate already
	// refuses Gemini scenes with no image.
	if len(req.AudioIDs) > 0 {
		input["audio_ids"] = req.AudioIDs
	}
	if len(req.VideoURLs) == 1 && len(req.VideoDurationSeconds) == 1 &&
		req.VideoDurationSeconds[0] != nil && *req.VideoDurationSeconds[0] > 0 {
		input["video_list"] = []map[string]any{{
			"url": req.VideoURLs[0], "start": 0, "ends": *req.VideoDurationSeconds[0],
		}}
	}
	return input
}

func geminiOmni12Input(req SubmitRequest) map[string]any {
	input := map[string]any{
		"prompt":       req.Prompt,
		"duration":     int(req.DurationSeconds),
		"aspect_ratio": req.AspectRatio,
		"resolution":   req.Resolution,
	}
	if len(req.ImageURLs) > 0 {
		input["image_urls"] = req.ImageURLs
	} else if req.ImageURL != "" {
		input["image_urls"] = []string{req.ImageURL}
	}
	return input
}

// nativeAudioModel resolves Kling into submit-time inputs.
//
// audioOn decides whether this specific render carries sound — it is what
// makes a Kling project's B-roll reachable at all: HasAudio used to be
// hardcoded true here, which was safe only because PickModel bounced every
// non-talking-head scene to a different model entirely. Now that a Kling
// project renders every scene through Kling (see PickModel's own doc
// comment), this has to say which kind of render was asked for — kie
// charges more for sound (27 against 18 at pro, 20 against 14 at std), and
// a silent cutaway with a spoken track is not a defensible substitute for
// the real thing.
//
// Resolution: settings.Resolution WHEN d.AllowedResolutions lists it, else
// d.DefaultResolution — same containsString shape standardModel uses below,
// not the unconditional d.DefaultResolution this used to return
// regardless of what was stored. That was safe exactly as long as Kling
// had one resolution tier: whatever settings.Resolution held, forcing it to
// the default landed on the only value that could ever be there anyway.
// It stopped being safe on 2026-09-10, when kie's `std` mode (720p) joined
// `pro` (1080p) as a second, cheaper, real tier — unconditionally
// returning DefaultResolution would have meant a /ugc project saved at
// std/720p silently rendered, and billed, at pro/1080p — caught in review,
// never shipped.
func nativeAudioModel(d Descriptor, audioOn bool, settings RenderSettings) Model {
	resolution := d.DefaultResolution
	if containsString(d.AllowedResolutions, settings.Resolution) {
		resolution = settings.Resolution
	}
	return Model{
		ID:                     d.ID,
		KieModelID:             d.KieModelID,
		Resolution:             resolution,
		AspectRatio:            aspectRatioFor(d, settings),
		HasAudio:               audioOn,
		SupportsRoleReferences: d.SupportsRoleReferences,
	}
}

// standardModel resolves a non-native-audio descriptor into submit-time
// inputs, given the project's render settings.
func standardModel(d Descriptor, settings RenderSettings, audioEnabled bool) Model {
	resolution := settings.Resolution
	if !containsString(d.AllowedResolutions, resolution) {
		resolution = d.DefaultResolution
	}

	m := Model{
		ID:                     d.ID,
		KieModelID:             d.KieModelID,
		Resolution:             resolution,
		AspectRatio:            aspectRatioFor(d, settings),
		DurationSendAsString:   d.DurationSendAsString,
		SupportsRoleReferences: d.SupportsRoleReferences,
	}
	// SupportsFPSInput, not len(AllowedFPS) > 0: AllowedFPS is also the
	// render gate's UI list and the set RenderSettingsSchema validates a
	// write against, so a model with no fps input still carries the one
	// rate it delivers at.
	if d.SupportsFPSInput && len(d.AllowedFPS) > 0 {
		m.FPS = settings.FPS
	}
	if d.SupportsGenerateAudio {
		generateAudio := audioEnabled
		m.GenerateAudio = &generateAudio
		m.HasAudio = generateAudio
	}
	return m
}

// PickModel resolves the per-project render settings into concrete
// submit-time inputs.
//
// Model choice is a per-project OPERATOR DECISION, not an automatic
// consequence of a scene's is_talking_head flag — settings.Model is
// authoritative. A project whose render_settings.model has never been
// touched (or explicitly names the default, seedance25) renders every
// scene on that silent default, full stop — is_talking_head has no power
// to override that. Only a project that has explicitly selected Kling can
// ever reach it, and even then only for scenes Kling exists for:
// talking-head scenes, with AUDIO_ENABLED=1.
//
// audioEnabled ALSO, independently of the above, turns on generate_audio
// for whatever descriptor this function returns that supports it — not
// conditioned on isTalkingHead, since Seedance has no per-scene "should
// this one speak" input beyond its prompt.
//
// Unlike the fal era, every descriptor here is always selectable — there
// is no Enabled/DisabledReason/Substituted branch left to take. See this
// file's own header comment.
func PickModel(isTalkingHead bool, audioEnabled bool, settings RenderSettings) (Model, error) {
	d, ok := DescriptorByID(settings.Model)
	if !ok {
		return Model{}, fmt.Errorf("unknown render model %q", settings.Model)
	}

	if d.NativeAudio {
		return nativeAudioModel(d, isTalkingHead && audioEnabled, settings), nil
	}
	return standardModel(d, settings, audioEnabled), nil
}

// EstimateCost returns kie's estimated USD cost of rendering
// durationSeconds of clip on model m, or ok=false when nobody has priced
// m's exact (ID, Resolution, HasAudio) combination.
//
// For a NativeAudio descriptor, ok=false cannot occur through PickModel's
// own resolution — TestRatesCoverAllowedResolutions in models_test.go
// requires BOTH a silent and a sound rate at every AllowedResolution (not
// just DefaultResolution), since 2026-09-10 — the std/720p entry that closed
// nativeAudioModel's own reachable-ok=false gap (see that function's doc
// comment). For a standard descriptor it can: the resolved (Resolution,
// HasAudio) pair may simply have no rate — seedance-2.5 has none at
// 720p/1080p with AUDIO_ENABLED, and seedance-2 / seedance-2-fast have none
// with it off. Either way — that gap, or a caller reached some other way (a
// hand-edited render_settings row bypassing ParseRenderSettings's
// validation, say) — this must not fabricate a number: the rule this whole
// rate table exists to enforce is that unknown is never zero and never
// another resolution's price. Every call site in this worker (dispatch.go,
// reconcile.go, ingest.go, the webhook handler) treats ok=false by logging
// loudly and recording runs.cost_usd as nil — never zero, never a guess —
// mirroring the *float64 nil-means-unknown convention store.Run.CostUSD
// already uses for a billing-unknown failure.
//
// kie bills exactly the seconds requested — no billed-seconds multiplier
// the way fal's Kling needed (a 6s request there was billed for 7.2s;
// every kie render measured so far has come back billed for precisely what
// was asked, in credits).
// MissingRateReason says WHICH rate is missing, for the log line that has to
// report an unavailable estimate.
//
// "no kie rate for resolved model/resolution" was true but pointed the wrong
// way: it reads as though this RESOLUTION is unpriced, so a reader goes to
// look at 480p/720p/1080p. The actual gap on every production /ugc render is
// narrower — Seedance is priced at all three resolutions and has no SOUND
// tier at all, while /ugc sends generate_audio: true on every submission. One
// of those is a missing measurement nobody has taken; the other is a
// resolution nobody has priced. They are found in different places and fixed
// by different work.
//
// Returns "" when a rate exists.
func MissingRateReason(m Model) string {
	if _, ok := rateFor(m.ID, m.Resolution, m.HasAudio); ok {
		return ""
	}
	if m.HasAudio {
		if _, silentOK := rateFor(m.ID, m.Resolution, false); silentOK {
			return "this model has no sound-tier rate; only a silent one has been measured"
		}
		return "neither a sound nor a silent rate exists for this resolution"
	}
	return "this resolution has no silent rate"
}

// GeminiOmniVideoPaid is the worker-side spend gate for the published-only
// Gemini schedule. Keep the gate separate from exact price lookup: a
// published price can be mathematically quotable but must not be submitted
// until a receipt exists.
func GeminiOmniVideoPaid(m Model) bool {
	if m.ID != "gemini-omni-video" {
		return true
	}
	rate, ok := rateFor(m.ID, m.Resolution, false)
	return ok && rate.Provenance == ProvenanceReceipt
}

// GeminiOmniVideoInputPaid is a separate gate because a no-video receipt
// does not validate the fixed-price source-video path.
func GeminiOmniVideoInputPaid(m Model) bool {
	if m.ID != "gemini-omni-video" {
		return true
	}
	rate, ok := Rates[m.ID].Video[m.Resolution]
	return ok && rate.Provenance == ProvenanceReceipt
}

func EstimateCost(m Model, durationSeconds float64) (usd float64, ok bool) {
	return EstimateCostWithVideo(m, durationSeconds, nil)
}

// EstimateCostWithVideo prices a render that may carry video references.
//
// A DIFFERENT TABLE, NOT THE SAME RATE OVER MORE SECONDS. kie's page says a
// video-conditioned render is Price x (Input + Output) and that structure is
// right, but the price inside it is not the one in the sound table:
// seedance-2.5 480p bills 17 cr/s with a video attached against 28 without.
// Measured 2026-09-10 over two renders — 136 credits for 4s out and 204 for
// 8s out, both carrying the same 4.064s video — and mirrored from
// web/lib/kie/rates.ts, which carries the receipts and the isolation.
//
// videoInputSeconds holds one entry per attached video, nil for the
// overwhelming majority of renders, which carry none and are priced exactly
// as they were before this existed.
//
// A NIL ENTRY MAKES THE WHOLE ESTIMATE UNKNOWN. An unmeasured reference is
// not a zero-length one, and quoting the render as though the video were
// free would be worse than the "unknown" the caller already knows how to
// print — that is the distinction models.go's header draws between unknown
// and free, and it applies with money on the line.
//
// The input seconds are counted WHOLE, rounded down: both receipts carried a
// 4.064s video and both land on an input of exactly 4. Whether kie floors
// the value or read the file as 4.0 is not separable from the two samples.
func EstimateCostWithVideo(m Model, durationSeconds float64, videoInputSeconds []*float64) (usd float64, ok bool) {
	if m.ID == "gemini-omni-video" {
		if len(videoInputSeconds) > 1 {
			return 0, false
		}
		if len(videoInputSeconds) == 1 {
			if videoInputSeconds[0] == nil || *videoInputSeconds[0] <= 0 || math.IsInf(*videoInputSeconds[0], 0) || math.IsNaN(*videoInputSeconds[0]) {
				return 0, false
			}
			credits, found := geminiOmniVideoCredits[m.Resolution]
			return credits / CreditsPerUSD, found
		}
		credits, found := geminiOmniNoVideoCredits[m.Resolution][int(durationSeconds)]
		return credits / CreditsPerUSD, found && durationSeconds == math.Trunc(durationSeconds)
	}
	if len(videoInputSeconds) == 0 {
		rate, ok := rateFor(m.ID, m.Resolution, m.HasAudio)
		if !ok {
			return 0, false
		}
		return rate.CreditsPerSecond * durationSeconds / CreditsPerUSD, true
	}

	rate, ok := videoRateFor(m.ID, m.Resolution)
	if !ok {
		// No fallback to the sound rate, deliberately. The two are far
		// enough apart (17 against 28) that a plausible wrong number would
		// be worse than the honest refusal the caller already handles.
		return 0, false
	}
	billedSeconds := durationSeconds
	for _, d := range videoInputSeconds {
		if d == nil {
			return 0, false
		}
		billedSeconds += math.Floor(*d)
	}
	return rate.CreditsPerSecond * billedSeconds / CreditsPerUSD, true
}

// videoRateFor is the per-second rate for a render carrying a video
// reference, or ok=false when this model and resolution have never been
// billed with one. See EstimateCostWithVideo for why there is no fallback.
func videoRateFor(modelID, resolution string) (RatePoint, bool) {
	rates, ok := Rates[modelID]
	if !ok {
		return RatePoint{}, false
	}
	if rates.Video == nil {
		return RatePoint{}, false
	}
	rp, ok := rates.Video[resolution]
	return rp, ok
}
