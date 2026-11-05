package loop

import (
	"context"

	"ugc-pipeline/worker/internal/store"
)

// fakeStore is a test double for the loop.Store seam (see deps.go). It
// embeds the interface (nil) rather than implementing all 14 methods: any
// method a test doesn't override compiles fine but panics on the first
// call, so a test that only means to exercise dispatch's lost-request-id
// path (say) gets a loud failure instead of a silent wrong answer if the
// code under test unexpectedly reaches, e.g., InsertRun.
//
// Override only what a given test needs, on a fresh &fakeStore{} per test.
type fakeStore struct {
	Store

	refFrameURL    string
	refFrameURLErr error

	markRenderingErr        error
	markRenderingCalls      int
	markRenderingRequestIDs []string

	markFailedCalls []markFailedCall
	markFailedErr   error

	insertRunCalls []store.Run

	// references overrides the RefFrameURL fallback with explicit
	// scene_references rows.
	references   []store.SceneReference
	insertRunErr error
}

func (f *fakeStore) RefFrameURL(ctx context.Context, sceneID string) (string, error) {
	if f.refFrameURLErr != nil {
		return "", f.refFrameURLErr
	}
	return f.refFrameURL, nil
}

// ReferencesForScene mirrors the real store's fallback: no scene_references
// rows (0071) means one image at ordinal 1, built from RefFrameURL. Every
// test predating that table sets only refFrameURL and keeps working
// unchanged. Set `references` to exercise the multi-reference path instead.
func (f *fakeStore) ReferencesForScene(ctx context.Context, sceneID string) ([]store.SceneReference, error) {
	if f.references != nil {
		return f.references, nil
	}
	key, err := f.RefFrameURL(ctx, sceneID)
	if err != nil {
		return nil, err
	}
	return []store.SceneReference{{StorageKey: key, Kind: "image", Ordinal: 1}}, nil
}

type markFailedCall struct {
	sceneID string
	run     store.Run
}

func (f *fakeStore) MarkRendering(ctx context.Context, sceneID, kieTaskID string) error {
	f.markRenderingCalls++
	f.markRenderingRequestIDs = append(f.markRenderingRequestIDs, kieTaskID)
	return f.markRenderingErr
}

func (f *fakeStore) MarkFailed(ctx context.Context, sceneID string, run store.Run) error {
	f.markFailedCalls = append(f.markFailedCalls, markFailedCall{sceneID: sceneID, run: run})
	return f.markFailedErr
}

func (f *fakeStore) InsertRun(ctx context.Context, run store.Run) error {
	f.insertRunCalls = append(f.insertRunCalls, run)
	return f.insertRunErr
}
