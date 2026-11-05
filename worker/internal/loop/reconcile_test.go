package loop

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"ugc-pipeline/worker/internal/config"
	"ugc-pipeline/worker/internal/store"
)

// ---------------------------------------------------------------------------
// bug 2: age-based give-up for a scene whose ingest keeps failing, and
// bug 3 (its twin): the same backstop for a scene whose fal status check
// (or result fetch, or re-fetch) keeps failing. Both paths share giveUp /
// giveUpDeadlinePassed, so these tests exercise the one shared mechanism
// rather than duplicating it per call site.
// ---------------------------------------------------------------------------

func TestGiveUpDeadlinePassed_BeforeThreshold(t *testing.T) {
	submittedAt := time.Now().Add(-10 * time.Minute)
	if giveUpDeadlinePassed(&submittedAt, 30*time.Minute) {
		t.Error("giveUpDeadlinePassed() = true for a scene 10m old with a 30m threshold, want false")
	}
}

func TestGiveUpDeadlinePassed_AfterThreshold(t *testing.T) {
	submittedAt := time.Now().Add(-31 * time.Minute)
	if !giveUpDeadlinePassed(&submittedAt, 30*time.Minute) {
		t.Error("giveUpDeadlinePassed() = false for a scene 31m old with a 30m threshold, want true")
	}
}

func TestGiveUpDeadlinePassed_ExactlyAtThreshold(t *testing.T) {
	// time.Since will always report slightly more than the nominal
	// duration by the time the comparison runs, so a submittedAt exactly
	// giveUpAfter in the past must already read as past-due (>=, not >).
	submittedAt := time.Now().Add(-30 * time.Minute)
	if !giveUpDeadlinePassed(&submittedAt, 30*time.Minute) {
		t.Error("giveUpDeadlinePassed() = false at the exact threshold boundary, want true")
	}
}

func TestGiveUpDeadlinePassed_NilSubmittedAt(t *testing.T) {
	// NULL < x is NULL in SQL; the Go analogue is a nil SubmittedAt that
	// must never let a scene retry forever just because the naive
	// time.Since(*nil) comparison can't be evaluated. nil must read as
	// already past the deadline, not as "never give up". This is exactly
	// the immortal-row trap this repo has already hit once (see AGENTS.md).
	if !giveUpDeadlinePassed(nil, 30*time.Minute) {
		t.Error("giveUpDeadlinePassed() = false for a nil submittedAt, want true (must not be immortal)")
	}
}

// giveUpReason is what actually lands in the scene's stored failure
// message via store.MarkFailed, so it's what makes the give-up visible to
// the operator and reachable by retryScene — it must name both the step
// that gave up and the real underlying cause, not just "gave up".
func TestGiveUpReason_IncludesCause(t *testing.T) {
	cause := errors.New(`fal: mock: unknown request id "mock-1786838789890545000-250037"`)
	got := giveUpReason("fal status check kept failing", cause)

	if !strings.Contains(got, "fal status check kept failing") {
		t.Errorf("giveUpReason() = %q, want it to name the step that gave up", got)
	}
	if !strings.Contains(got, cause.Error()) {
		t.Errorf("giveUpReason() = %q, want it to include the underlying fal error text %q", got, cause.Error())
	}
}

func TestMarkFailed_PersistsAcceptedKieTaskID(t *testing.T) {
	requestID := "fal-request-failed-1"
	fs := &fakeStore{}
	deps := Deps{Store: fs, Config: &config.Config{}}
	scene := store.Scene{
		ID:            "scene-1",
		ProjectID:     "project-1",
		DurationS:     8,
		Status:        "rendering",
		KieTaskID:     &requestID,
		IsTalkingHead: false,
	}

	markFailed(context.Background(), deps, testLogger(), scene, "timeout")

	if len(fs.markFailedCalls) != 1 {
		t.Fatalf("MarkFailed called %d times, want 1", len(fs.markFailedCalls))
	}
	run := fs.markFailedCalls[0].run
	if run.KieTaskID == nil || *run.KieTaskID != requestID {
		t.Errorf("MarkFailed run.KieTaskID = %v, want %q", run.KieTaskID, requestID)
	}
	if run.CostUSD == nil {
		t.Fatal("MarkFailed run.CostUSD = nil for an accepted fal request")
	}
}
