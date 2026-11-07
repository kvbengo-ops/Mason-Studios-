package loop

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"ugc-pipeline/worker/internal/byteplus"
	"ugc-pipeline/worker/internal/config"
	"ugc-pipeline/worker/internal/store"
)

// dispatchWithSubmitErr runs one claimed scene through dispatchScene with a
// vendor whose Submit fails with submitErr.
func dispatchWithSubmitErr(t *testing.T, fs *fakeStore, submitErr error) {
	t.Helper()
	dispatchWithRequeues(t, fs, submitErr, nil)
}

func dispatchWithRequeues(t *testing.T, fs *fakeStore, submitErr error, requeues *CapacityRequeues) {
	t.Helper()
	signSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"signedURL":"/object/sign/media/projects/project-1/ref_frame/scene-1.png?token=test"}`))
	}))
	t.Cleanup(signSrv.Close)
	fs.refFrameURL = "projects/project-1/ref_frame/scene-1.png"

	deps := Deps{
		Store: fs,
		Config: &config.Config{
			SupabaseURL:            signSrv.URL,
			SupabaseServiceRoleKey: "test-key",
			AppBaseURL:             "https://worker.example",
			RenderConcurrency:      10,
		},
		Logger:           testLogger(),
		Kie:              &fakeVideoVendor{submitErr: submitErr},
		CapacityRequeues: requeues,
	}
	scene := store.Scene{ID: "scene-1", ProjectID: "project-1", DurationS: 8, Status: "rendering"}
	dispatchScene(context.Background(), deps, scene, "https://worker.example")
}

// A capacity refusal reached no vendor and billed nothing: the scene goes back
// in the queue, it is not failed.
func TestDispatchScene_AtCapacity_ReturnsSceneToQueue(t *testing.T) {
	fs := &fakeStore{}
	dispatchWithSubmitErr(t, fs, fmt.Errorf("byteplus: submit x: %w", byteplus.ErrAtCapacity))

	if len(fs.releaseCalls) != 1 || fs.releaseCalls[0] != "scene-1" {
		t.Errorf("ReleaseUnsubmittedClaim calls = %v, want [scene-1]", fs.releaseCalls)
	}
	if len(fs.markFailedCalls) != 0 {
		t.Errorf("MarkFailed called %d times, want 0 — a capacity refusal is not a failure", len(fs.markFailedCalls))
	}
}

// If the scene cannot be put back, it must still end somewhere: failed, with
// the reason, rather than left 'rendering' with no task id.
func TestDispatchScene_AtCapacity_ReleaseFailureFailsTheScene(t *testing.T) {
	fs := &fakeStore{releaseErr: store.ErrNotFound}
	dispatchWithSubmitErr(t, fs, fmt.Errorf("byteplus: submit x: %w", byteplus.ErrAtCapacity))

	if len(fs.markFailedCalls) != 1 {
		t.Fatalf("MarkFailed called %d times, want 1", len(fs.markFailedCalls))
	}
}

// Every other submit error — a refusal, no key, routing off — still fails the
// scene and never touches the queue.
func TestDispatchScene_OtherSubmitErrors_StillFailTheScene(t *testing.T) {
	fs := &fakeStore{}
	dispatchWithSubmitErr(t, fs, errors.New("byteplus: submit x: ModelNotOpen"))

	if len(fs.releaseCalls) != 0 {
		t.Errorf("ReleaseUnsubmittedClaim called %v, want never", fs.releaseCalls)
	}
	if len(fs.markFailedCalls) != 1 {
		t.Errorf("MarkFailed called %d times, want 1", len(fs.markFailedCalls))
	}
}

// A scene that keeps hitting the backstop is not requeued forever: something
// makes the count look permanently full, and failing says so where a silent
// 30s loop would not.
func TestDispatchScene_AtCapacity_FailsAfterMaxRequeues(t *testing.T) {
	fs := &fakeStore{}
	requeues := &CapacityRequeues{}
	atCap := fmt.Errorf("byteplus: submit x: %w", byteplus.ErrAtCapacity)

	for i := 0; i < maxCapacityRequeues; i++ {
		dispatchWithRequeues(t, fs, atCap, requeues)
	}
	if len(fs.releaseCalls) != maxCapacityRequeues || len(fs.markFailedCalls) != 0 {
		t.Fatalf("after %d refusals: %d requeues, %d failures; want %d and 0",
			maxCapacityRequeues, len(fs.releaseCalls), len(fs.markFailedCalls), maxCapacityRequeues)
	}

	dispatchWithRequeues(t, fs, atCap, requeues)
	if len(fs.releaseCalls) != maxCapacityRequeues || len(fs.markFailedCalls) != 1 {
		t.Fatalf("refusal %d: %d requeues, %d failures; want it failed, not requeued",
			maxCapacityRequeues+1, len(fs.releaseCalls), len(fs.markFailedCalls))
	}
	if got := requeues.note("scene-1"); got != 1 {
		t.Errorf("count after failing = %d, want it forgotten (next note 1)", got)
	}
}
