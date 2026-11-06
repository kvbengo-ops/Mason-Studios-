package byteplus

import (
	"context"
	"fmt"
	"strings"

	"ugc-pipeline/worker/internal/kie"
)

// Vendor is loop.VideoVendor's method set, restated here so this package does
// not import loop (cmd/worker/main.go pins that Router satisfies the real
// one).
type Vendor interface {
	Submit(ctx context.Context, req kie.SubmitRequest) (string, error)
	Status(ctx context.Context, requestID string) (kie.Status, error)
	Result(ctx context.Context, requestID string) (kie.Result, error)
	BilledUSD(ctx context.Context, requestID string) (*float64, error)
}

// videoMarker follows kie.BytePlusTaskPrefix when the render carried a
// reference video. BytePlus prices those tokens lower, and its get-task
// response does not echo the inputs, so the one fact the bill depends on is
// written where it will be read back: in the id we persist.
const videoMarker = "video:"

// Router is the worker's one video vendor: Seedance 2.5 goes to BytePlus
// when BytePlus is configured, everything else to Kie. Polls route back by
// the id's prefix, so a render submitted before the key was removed (or
// added) still resolves against the vendor that is actually running it.
type Router struct {
	Kie      Vendor
	BytePlus *Client // nil = BytePlus off; every render goes to Kie.
}

// Submit sends a render to its vendor and returns the id to persist.
func (r Router) Submit(ctx context.Context, req kie.SubmitRequest) (string, error) {
	if r.BytePlus == nil || req.KieModelID != KieSeedance25 {
		return r.Kie.Submit(ctx, req)
	}
	id, err := r.BytePlus.create(ctx, buildCreateRequest(req))
	if err != nil {
		return "", fmt.Errorf("byteplus: submit %s: %w", req.KieModelID, err)
	}
	marker := ""
	if len(req.VideoURLs) > 0 {
		marker = videoMarker
	}
	return kie.BytePlusTaskPrefix + marker + id, nil
}

// parseID splits a persisted id. ok is false for a kie id.
func parseID(requestID string) (id string, withVideo, ok bool) {
	rest, ok := strings.CutPrefix(requestID, kie.BytePlusTaskPrefix)
	if !ok {
		return "", false, false
	}
	id, withVideo = strings.CutPrefix(rest, videoMarker)
	return id, withVideo, true
}

// fetch reads a BytePlus task, refusing one that comes from a Router with no
// client — a key removed while a render was in flight.
func (r Router) fetch(ctx context.Context, id string) (task, error) {
	if r.BytePlus == nil {
		return task{}, fmt.Errorf("byteplus: task %s was submitted to BytePlus, but BYTEPLUS_API_KEY is no longer set", id)
	}
	return r.BytePlus.get(ctx, id)
}

// Status maps BytePlus's states onto kie.Status. "expired" and "cancelled"
// are terminal and never billed, so they read as failed.
func (r Router) Status(ctx context.Context, requestID string) (kie.Status, error) {
	id, _, ok := parseID(requestID)
	if !ok {
		return r.Kie.Status(ctx, requestID)
	}
	t, err := r.fetch(ctx, id)
	if err != nil {
		return "", fmt.Errorf("byteplus: status %s: %w", id, err)
	}
	return statusOf(t.Status), nil
}

func statusOf(s string) kie.Status {
	switch s {
	case "succeeded":
		return kie.StatusCompleted
	case "failed", "expired", "cancelled":
		return kie.StatusFailed
	case "queued":
		return kie.StatusInQueue
	default:
		// "running", and any state BytePlus adds later: still working, check
		// again — the same safe reading kie's statusFromState gives an
		// unknown state. reconcile's timeout still bounds it.
		return kie.StatusInProgress
	}
}

// Result returns a finished render's video and what BytePlus billed for it.
func (r Router) Result(ctx context.Context, requestID string) (kie.Result, error) {
	id, withVideo, ok := parseID(requestID)
	if !ok {
		return r.Kie.Result(ctx, requestID)
	}
	t, err := r.fetch(ctx, id)
	if err != nil {
		return kie.Result{}, fmt.Errorf("byteplus: result %s: %w", id, err)
	}
	if t.Status != "succeeded" {
		return kie.Result{}, fmt.Errorf("byteplus: result %s: task is %q, not succeeded", id, t.Status)
	}
	if t.Content.VideoURL == "" {
		return kie.Result{}, fmt.Errorf("byteplus: result %s: succeeded with no content.video_url", id)
	}
	return kie.Result{
		VideoURL:        t.Content.VideoURL,
		DurationSeconds: t.Duration,
		ActualCostUSD:   costUSD(t, withVideo),
	}, nil
}

// BilledUSD is BytePlus's charge: tokens x price on success, 0 for a task
// that ended without a video (BytePlus bills only successful videos, and
// kie.FailedRunCost reads 0 as "not billed"), nil while it is still running.
func (r Router) BilledUSD(ctx context.Context, requestID string) (*float64, error) {
	id, withVideo, ok := parseID(requestID)
	if !ok {
		return r.Kie.BilledUSD(ctx, requestID)
	}
	t, err := r.fetch(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("byteplus: billed %s: %w", id, err)
	}
	switch statusOf(t.Status) {
	case kie.StatusCompleted:
		return costUSD(t, withVideo), nil
	case kie.StatusFailed:
		zero := 0.0
		return &zero, nil
	default:
		return nil, nil
	}
}
