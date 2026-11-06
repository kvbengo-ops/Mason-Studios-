package byteplus

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"ugc-pipeline/worker/internal/kie"
)

// Vendor is loop.VideoVendor's method set, restated here so this package does
// not import loop (cmd/worker/main.go pins that *Router satisfies the real
// one).
type Vendor interface {
	Submit(ctx context.Context, req kie.SubmitRequest) (string, error)
	Status(ctx context.Context, requestID string) (kie.Status, error)
	Result(ctx context.Context, requestID string) (kie.Result, error)
	BilledUSD(ctx context.Context, requestID string) (*float64, error)
}

type submissionError struct {
	model string
	err   error
}

func (e *submissionError) Error() string {
	return fmt.Sprintf("byteplus: submit %s: %v", e.model, e.err)
}

func (e *submissionError) Unwrap() error            { return e.err }
func (e *submissionError) SubmissionVendor() string { return kie.BytePlusVendor }

// videoMarker follows kie.BytePlusTaskPrefix when the render carried a
// reference video. BytePlus prices those tokens lower, and its get-task
// response does not echo the inputs, so the one fact the bill depends on is
// written where it will be read back: in the id we persist.
const videoMarker = "video:"

const (
	// minCreateGap spaces BytePlus creates ~5/s. Seedance 2.x has burst
	// protection (RequestBurstTooFast) on top of its per-minute limit
	// (Individual 180 RPM, Enterprise 600), and one dispatch tick can claim
	// RENDER_CONCURRENCY scenes at once.
	minCreateGap = 200 * time.Millisecond
	// recentWindow covers the gap between a create returning and dispatch
	// persisting the id (markRenderingWithRetry — milliseconds), during which
	// Inflight's database count cannot see the task yet.
	recentWindow = 15 * time.Second
)

// Router is the worker's one video vendor: the Seedance 2.5 · BytePlus pick
// goes to BytePlus and ONLY BytePlus; every other model goes to Kie. A
// BytePlus render that cannot go to BytePlus (no key, routing off, at its
// cap, refused) fails the scene with the reason — it never falls back to kie.
// The fallback silently billed kie for BytePlus picks while ModelNotOpen
// refused every one (2026-11-06), so the pick now means the vendor.
// Polls route back by the id's prefix, so a render submitted before routing
// changed still resolves against the vendor actually running it.
//
// Use it as a pointer: it holds a mutex.
type Router struct {
	Kie Vendor
	// BytePlus is the client used to submit AND poll. nil = no key: a BytePlus
	// pick fails, and a BytePlus id cannot be polled.
	BytePlus *Client
	// Mock (MODE=development) sends the BytePlus pick through Kie's mocked
	// client, so development renders it without a key and without billing.
	Mock bool
	// Route sends new Seedance 2.5 renders to BytePlus. False (BYTEPLUS_ROUTE=0)
	// stops new submissions (they fail) while BytePlus keeps polling the tasks
	// already running there — the safe way to switch it off.
	Route bool
	// MaxInflight caps BytePlus tasks running at once (BYTEPLUS_MAX_INFLIGHT;
	// Individual accounts get 3, Enterprise 10). Over the account's limit
	// BytePlus does not refuse — it QUEUES, and the queued time counts toward
	// execution_expires_after — so the cap is enforced here and the overflow
	// fails with "try again".
	MaxInflight int
	// Inflight counts BytePlus tasks still rendering (scenes in 'rendering'
	// whose task id carries kie.BytePlusTaskPrefix).
	Inflight func(ctx context.Context) (int, error)
	Log      *slog.Logger

	mu         sync.Mutex
	lastCreate time.Time
	recent     []time.Time
}

func (r *Router) logger() *slog.Logger {
	if r.Log != nil {
		return r.Log
	}
	return slog.Default()
}

// Submit sends a render to its vendor and returns the id to persist.
func (r *Router) Submit(ctx context.Context, req kie.SubmitRequest) (string, error) {
	if req.SelectedModelID != kie.BytePlusSeedance25ID || r.Mock {
		return r.Kie.Submit(ctx, req)
	}
	var id string
	var err error
	switch {
	case r.BytePlus == nil:
		err = errors.New("BYTEPLUS_API_KEY is not set on the worker; this model renders on BytePlus only")
	case !r.Route:
		err = errors.New("BYTEPLUS_ROUTE=0 has paused new BytePlus renders; this model renders on BytePlus only")
	default:
		id, err = r.submitBytePlus(ctx, req)
	}
	if err != nil {
		return "", &submissionError{model: req.KieModelID, err: err}
	}
	marker := ""
	if len(req.VideoURLs) > 0 {
		marker = videoMarker
	}
	return kie.BytePlusTaskPrefix + marker + id, nil
}

// submitBytePlus holds the lock across the capacity check and the create, so
// two goroutines from one dispatch tick cannot both see the last free slot.
//
// shortcut: the cap is per process; use a shared Postgres claim before running multiple workers.
func (r *Router) submitBytePlus(ctx context.Context, req kie.SubmitRequest) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	now := time.Now()
	kept := r.recent[:0]
	for _, t := range r.recent {
		if now.Sub(t) < recentWindow {
			kept = append(kept, t)
		}
	}
	r.recent = kept

	if r.MaxInflight > 0 {
		if r.Inflight == nil {
			return "", errors.New("the BytePlus in-flight counter is unavailable; try again")
		}
		n, err := r.Inflight(ctx)
		if err != nil {
			return "", fmt.Errorf("could not count BytePlus renders in flight; try again: %w", err)
		}
		// Counts a just-persisted task twice for up to recentWindow, which
		// errs toward refusing, never toward BytePlus's queue.
		if n+len(r.recent) >= r.MaxInflight {
			r.logger().Info("byteplus: at max in-flight, failing this render",
				slog.Int("inflight", n+len(r.recent)), slog.Int("max", r.MaxInflight))
			return "", fmt.Errorf("BytePlus is already running its limit of %d renders; try again when one finishes", r.MaxInflight)
		}
	}

	if wait := minCreateGap - time.Since(r.lastCreate); wait > 0 {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(wait):
		}
	}
	r.lastCreate = time.Now()

	id, err := r.BytePlus.create(ctx, buildCreateRequest(req, r.BytePlus.model))
	if err != nil {
		return "", err
	}
	r.recent = append(r.recent, time.Now())
	return id, nil
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
// client — the key removed while a render was in flight (BYTEPLUS_ROUTE=0 is
// the way to stop new renders without stranding these).
func (r *Router) fetch(ctx context.Context, id string) (task, error) {
	if r.BytePlus == nil {
		return task{}, fmt.Errorf("byteplus: task %s was submitted to BytePlus, but BYTEPLUS_API_KEY is no longer set", id)
	}
	return r.BytePlus.get(ctx, id)
}

// Status maps BytePlus's states onto kie.Status. "expired" and "cancelled"
// are terminal and never billed, so they read as failed.
func (r *Router) Status(ctx context.Context, requestID string) (kie.Status, error) {
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

// FailureReason is why a BytePlus task ended without a video, in words an
// editor can act on, or "" for a kie id (reconcile keeps its own wording).
func (r *Router) FailureReason(ctx context.Context, requestID string) (string, error) {
	id, _, ok := parseID(requestID)
	if !ok {
		return "", nil
	}
	t, err := r.fetch(ctx, id)
	if err != nil {
		return "", err
	}
	switch {
	case t.Status == "expired":
		return "BytePlus expired this render: it was not finished within an hour of being submitted (nothing was charged).", nil
	case t.Error != nil:
		return readable(t.Error.Code, t.Error.Message), nil
	default:
		return "BytePlus reported the render " + t.Status + ".", nil
	}
}

// Result returns a finished render's video and what BytePlus billed for it.
func (r *Router) Result(ctx context.Context, requestID string) (kie.Result, error) {
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
func (r *Router) BilledUSD(ctx context.Context, requestID string) (*float64, error) {
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
