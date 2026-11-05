package kie

import "errors"

// This file holds the vendor-neutral vocabulary that used to live in
// internal/fal/client.go: Status, SubmitRequest, Result, and
// ErrSubmissionOutcomeUnknown. It was never actually fal-specific — every
// field already described "submit/poll/fetch a video render" in terms kie
// could satisfy without a translation layer (loop.VideoVendor's whole point
// was that both fal.Client and kie.Client implemented the same shape) — so
// when fal.ai was decommissioned, these types simply moved to their only
// remaining implementer instead of being reinvented. Vendor is now always
// "kie" (see the Vendor const below); there is no second implementation for
// this vocabulary to stay neutral between.

// Vendor is the constant runs.vendor value for every render this worker
// records. It exists as a named constant, not a literal "kie" string
// scattered across dispatch.go/reconcile.go/ingest.go/the webhook handler,
// so the one place that ever needs to change it is this line — the same
// reason CREDITS_PER_USD in web/lib/kie/rates.ts is a named export rather
// than a repeated 200.
const Vendor = "kie"

// Status is a video render's lifecycle state, translated from kie's own
// vocabulary by statusFromState in client.go. StatusFailed is not one of
// kie's own reported states — it is this client's sentinel for "the request
// reached a terminal error state" (see statusFromState).
type Status string

const (
	StatusInQueue    Status = "IN_QUEUE"
	StatusInProgress Status = "IN_PROGRESS"
	StatusCompleted  Status = "COMPLETED"
	StatusFailed     Status = "ERROR"
)

// SubmitRequest is everything Client.Submit needs to start one render.
//
// ImageURLField/ImageURLsField, which this type carried in the fal era to
// tell fal.Client.Submit which request-body key the reference frame went
// under (a bare "image_url" string vs. LTX vs. Kling's differing field
// names), are gone rather than renamed: kie.Client.Submit never read them
// even before fal was deleted (see seedanceInput/klingInput/hailuoInput's
// own doc comments in models.go — each buildInput function owns its
// model's ENTIRE input shape, image field included, rather than being told
// the field name by the caller), so carrying them forward would be dead
// weight with no reader.
type SubmitRequest struct {
	// KieModelID is the string kie itself expects in createTask's "model"
	// field, and the key Client.Submit looks up a Descriptor's BuildInput
	// by — see DescriptorByKieModelID. Descriptor.KieModelID is the only
	// source for this value; nothing constructs it by hand.
	KieModelID string
	Prompt     string
	ImageURL   string // reference frame; the character-consistency mechanism.
	// ImageURLs is EVERY reference image for this scene, in the order the
	// vendor indexes them — element 0 is the "@image1" the prompt can name
	// (0071's scene_references.ordinal).
	//
	// ImageURL above is element 0, kept as its own field because Kling and
	// Hailuo take exactly one picture and their builders read it directly.
	// Only Seedance's reference_image_urls carries the whole list.
	//
	// AudioURLs is every voice reference for this scene, same ordering rule
	// and same table — scene_references rows of kind 'audio'. Seedance is the
	// only model that takes them (reference_audio_urls); Kling and Hailuo
	// have no equivalent field and their builders ignore this.
	//
	// VideoURLs is every video reference for this scene, same ordering rule
	// and same table — scene_references rows of kind 'video' (0094_video_
	// scene_reference.sql; note this matches elements.category's spelling,
	// not the assets.kind 'video_ref' the file itself was uploaded under —
	// scene_references.kind has always named the vendor array a row feeds,
	// never the storage vocabulary behind it, same as 'image' and 'audio'
	// before it). Seedance is the only model that takes them
	// (reference_video_urls); Kling and Hailuo have no equivalent field and
	// their builders ignore this, same as AudioURLs above.
	//
	// UNLIKE the two fields above it, this one changes what the render
	// COSTS, not just what it contains — see seedanceInput's own comment in
	// models.go for the rate note this field triggers.
	//
	// Empty is legal and means "just ImageURL": every caller predating
	// scene_references sets only the single field, and seedanceInput falls
	// back to it rather than submitting nothing.
	ImageURLs []string
	AudioURLs []string
	VideoURLs []string
	// VideoDurationSeconds is parallel to VideoURLs. Pointers preserve an
	// unmeasured duration without dropping an entry and breaking parallelism;
	// Gemini rejects nil before submission.
	VideoDurationSeconds []*float64
	// AudioIDs is Gemini only: kie voice ids (a lowercase preset name like
	// "achernar"), never URLs. Seedance's voice files stay in AudioURLs.
	AudioIDs        []string
	DurationSeconds float64
	WebhookURL      string

	Resolution  string
	AspectRatio string
	FPS         int
	// DurationSendAsString sends `duration` as a JSON string rather than a
	// number — see Descriptor.DurationSendAsString for which models need it
	// and why it is a per-model fact, not a global one.
	DurationSendAsString bool
	GenerateAudio        *bool
	// HasAudio is whether this render should carry sound. Distinct from
	// GenerateAudio above (a Seedance-only request-body field, sent under
	// `generate_audio`): Kling has no such field at all, and reads this
	// instead as `sound` — see klingInput in models.go.
	HasAudio bool
}

// Result carries a completed render's output.
type Result struct {
	VideoURL        string
	DurationSeconds float64
	// InferenceMS is left for a vendor that reports its own generation
	// time via a status/queue endpoint the way fal.ai's
	// metrics.inference_time did. kie's recordInfo carries no equivalent
	// field (see client.go's header comment on what is and isn't in that
	// response), so kie.Client.Result never sets this — it stays nil on
	// every kie render, distinct from runs.latency_ms (this worker's own
	// submit-to-detection time; see loop/reconcile.go's staleAfter comment).
	InferenceMS *int
	// ActualCostUSD is a vendor-reported charge for this specific render,
	// populated only when the vendor's own API hands one back.
	// kie.Client.Result sets this from recordInfo's creditsConsumed field
	// (1 credit = $0.005 — see creditUSD in client.go). Every caller that
	// turns a Result into runs.cost_usd (internal/ingest.FromResult) must
	// prefer this over EstimateCost's estimate when it is non-nil: an
	// estimate exists to approximate a bill nobody can read back yet; a
	// vendor that actually reports the bill makes the estimate unnecessary
	// for that one render.
	ActualCostUSD *float64
}

// ErrSubmissionOutcomeUnknown marks a non-idempotent request whose response
// was lost or ambiguous. The vendor may already have accepted and billed the
// job, so callers must record the uncertainty (see store.BillingUnknownPrefix)
// and must not replay the request automatically without a vendor-backed
// idempotency key.
//
// Moved here from fal/client.go verbatim, and — unlike most of this
// migration — NOT just a rename. Until this change, only fal.Client's
// doJSON ever produced this sentinel; kie.Client's own classifyAmbiguousFailure
// (client.go) had no equivalent, so an ambiguous lost-POST failure on kie
// was silently recorded as a confident, free ($0) failure instead of a
// billing-unknown one — invisible while fal was still the vendor most
// submissions went through, and a real gap the moment kie became the only
// vendor. classifyAmbiguousFailure and doOnce's 408-on-POST branch both now
// wrap this, mirroring exactly what fal's doJSON used to do.
var ErrSubmissionOutcomeUnknown = errors.New("kie: submission outcome unknown")
