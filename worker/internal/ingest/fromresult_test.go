package ingest

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"ugc-pipeline/worker/internal/config"
	"ugc-pipeline/worker/internal/kie"
	"ugc-pipeline/worker/internal/media"
	"ugc-pipeline/worker/internal/store"
)

// ---------------------------------------------------------------------------
// Test scaffolding
//
// deps.Media is *media.Runner, which shells out to real "ffmpeg"/"ffprobe"
// binaries — installFakeFFmpeg below still stands in for that. deps.Store
// is now the ingest.Store interface (see ingest.go), so it no longer needs
// a nil-receiver trick: fakeStore is a real in-process fake that records
// every MarkDone/InsertAsset call it receives, which is what makes the
// happy-path assertions below possible at all — the previous version of
// this file could only prove the store was NOT touched, never observe what
// it was actually handed.
// ---------------------------------------------------------------------------

// markDoneCall is one recorded call to fakeStore.MarkDone.
type markDoneCall struct {
	sceneID string
	asset   store.Asset
	run     store.Run
}

// fakeStore is a test double for ingest.Store. It embeds the interface
// (nil) rather than implementing every method: any method this file
// doesn't override compiles fine but panics on the first call, which is
// exactly the "loud trap" property the old nil-*store.Store technique
// existed to provide, minus the dependency on store.MarkDone's internals to
// get it. Override only MarkDone/InsertAsset, since those are the only two
// methods FromResult ever calls (see ingest.Store's doc comment).
type fakeStore struct {
	Store

	markDoneCalls []markDoneCall
	markDoneErr   error
	// beforeMarkDone, if set, runs synchronously at the top of MarkDone —
	// used by the ordering test below to snapshot other state (e.g. whether
	// the upload has already landed) at the exact moment MarkDone is
	// reached, rather than only at some later point.
	beforeMarkDone func()

	insertAssetCalls []store.Asset
	insertAssetErr   error
}

func (f *fakeStore) MarkDone(ctx context.Context, sceneID string, asset store.Asset, run store.Run) error {
	if f.beforeMarkDone != nil {
		f.beforeMarkDone()
	}
	f.markDoneCalls = append(f.markDoneCalls, markDoneCall{sceneID: sceneID, asset: asset, run: run})
	return f.markDoneErr
}

func (f *fakeStore) InsertAsset(ctx context.Context, asset store.Asset) (string, error) {
	f.insertAssetCalls = append(f.insertAssetCalls, asset)
	if f.insertAssetErr != nil {
		return "", f.insertAssetErr
	}
	return "fake-asset-id", nil
}

func testScene(t *testing.T) store.Scene {
	t.Helper()
	// KieTaskID is set because a scene reaching ingest always has one: both
	// callers resolve the scene BY it. It is also load-bearing now — the clip
	// and poster storage keys are built per attempt from this id, so a fixture
	// without one describes a state that cannot occur and would exercise a
	// refusal instead of the path under test.
	taskID := "kie-task-fixture"
	return store.Scene{
		ID:            "scene-1",
		ProjectID:     "project-1",
		IsTalkingHead: false,
		DurationS:     8,
		Status:        "rendering",
		KieTaskID:     &taskID,
	}
}

func testResult(t *testing.T, videoURL string) kie.Result {
	t.Helper()
	inference := 4200
	return kie.Result{
		VideoURL:        videoURL,
		DurationSeconds: 8,
		InferenceMS:     &inference,
	}
}

// installFakeFFmpeg writes fake "ffmpeg" and "ffprobe" executables to a temp
// dir and prepends it to PATH for the duration of the test (t.Setenv
// restores PATH automatically). ffmpegExit controls the fake ffmpeg's exit
// code; ffprobe always reports audio matching media.Runner.Normalize's
// pinned format, so a 0 ffmpegExit reaches a clean Normalize success and a
// non-zero one fails only at the ffmpeg step, same as a real encode error.
func installFakeFFmpeg(t *testing.T, ffmpegExit int) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake ffmpeg/ffprobe shell scripts require a POSIX shell")
	}

	dir := t.TempDir()

	ffprobe := "#!/bin/sh\n" +
		"case \"$*\" in\n" +
		"  *sample_rate,channels*) echo \"48000,2\" ;;\n" +
		"  *codec_type*) ;;\n" +
		"  *) exit 1 ;;\n" +
		"esac\n" +
		"exit 0\n"
	if err := os.WriteFile(filepath.Join(dir, "ffprobe"), []byte(ffprobe), 0o755); err != nil {
		t.Fatalf("write fake ffprobe: %v", err)
	}

	ffmpeg := "#!/bin/sh\n"
	if ffmpegExit == 0 {
		ffmpeg += "exit 0\n"
	} else {
		ffmpeg += "echo 'fake ffmpeg failure' 1>&2\n"
		ffmpeg += "exit 1\n"
	}
	if err := os.WriteFile(filepath.Join(dir, "ffmpeg"), []byte(ffmpeg), 0o755); err != nil {
		t.Fatalf("write fake ffmpeg: %v", err)
	}

	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError + 1}))
}

// ---------------------------------------------------------------------------
// Short-circuit tests: each failure stage must return before deps.Store is
// ever touched. fakeStore now makes that a direct assertion — no MarkDone
// or InsertAsset calls recorded — rather than an inference from a nil
// receiver's panic.
// ---------------------------------------------------------------------------

func TestFromResult_DownloadFailureNeverReachesStore(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	fs := &fakeStore{}
	deps := Deps{
		Store:  fs,
		Config: &config.Config{},
		Media:  nil,
		Logger: testLogger(),
	}

	err := FromResult(context.Background(), deps, testScene(t), testResult(t, srv.URL))
	if err == nil {
		t.Fatalf("FromResult: expected error from a failed download, got nil")
	}
	if !strings.Contains(err.Error(), "status 500") {
		t.Fatalf("FromResult error = %q, want it to surface the download failure (status 500)", err.Error())
	}
	if len(fs.markDoneCalls) != 0 || len(fs.insertAssetCalls) != 0 {
		t.Fatalf("FromResult: store touched after a download failure: MarkDone=%d InsertAsset=%d calls, want 0 of each",
			len(fs.markDoneCalls), len(fs.insertAssetCalls))
	}
}

func TestFromResult_NormalizeFailureNeverReachesStore(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("fake clip bytes"))
	}))
	defer srv.Close()
	installFakeFFmpeg(t, 1) // ffmpeg itself fails

	fs := &fakeStore{}
	deps := Deps{
		Store:  fs,
		Config: &config.Config{},
		Media:  media.NewRunner(1),
		Logger: testLogger(),
	}

	err := FromResult(context.Background(), deps, testScene(t), testResult(t, srv.URL))
	if err == nil {
		t.Fatalf("FromResult: expected error from a failed normalize, got nil")
	}
	if !strings.Contains(err.Error(), "fake ffmpeg failure") {
		t.Fatalf("FromResult error = %q, want it to surface the normalize/ffmpeg failure", err.Error())
	}
	if len(fs.markDoneCalls) != 0 || len(fs.insertAssetCalls) != 0 {
		t.Fatalf("FromResult: store touched after a normalize failure: MarkDone=%d InsertAsset=%d calls, want 0 of each",
			len(fs.markDoneCalls), len(fs.insertAssetCalls))
	}
}

func TestFromResult_UploadFailureNeverReachesStore(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("fake clip bytes"))
	}))
	defer srv.Close()
	installFakeFFmpeg(t, 0) // normalize succeeds

	uploadSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("upstream storage error"))
	}))
	defer uploadSrv.Close()

	fs := &fakeStore{}
	deps := Deps{
		Store: fs,
		Config: &config.Config{
			SupabaseURL:            uploadSrv.URL,
			SupabaseServiceRoleKey: "test-key",
		},
		Media:  media.NewRunner(1),
		Logger: testLogger(),
	}

	err := FromResult(context.Background(), deps, testScene(t), testResult(t, srv.URL))
	if err == nil {
		t.Fatalf("FromResult: expected error from a failed upload, got nil")
	}
	if !strings.Contains(err.Error(), "upload object") {
		t.Fatalf("FromResult error = %q, want it to surface the upload failure", err.Error())
	}
	if len(fs.markDoneCalls) != 0 || len(fs.insertAssetCalls) != 0 {
		t.Fatalf("FromResult: store touched after an upload failure: MarkDone=%d InsertAsset=%d calls, want 0 of each",
			len(fs.markDoneCalls), len(fs.insertAssetCalls))
	}
}

// ---------------------------------------------------------------------------
// Order test: the upload must complete (be observed by the fake storage
// server) BEFORE FromResult reaches deps.Store.MarkDone. fakeStore's
// beforeMarkDone hook snapshots uploadObserved at the exact instant MarkDone
// is called; if upload and MarkDone were ever reordered, that snapshot would
// be false even though the upload eventually happens.
// ---------------------------------------------------------------------------

func TestFromResult_UploadHappensBeforeMarkDoneIsReached(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("fake clip bytes"))
	}))
	defer srv.Close()
	installFakeFFmpeg(t, 0)

	var uploadObserved bool
	uploadSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		uploadObserved = true
		w.WriteHeader(http.StatusOK)
	}))
	defer uploadSrv.Close()

	var uploadObservedAtMarkDone bool
	fs := &fakeStore{
		beforeMarkDone: func() { uploadObservedAtMarkDone = uploadObserved },
	}
	deps := Deps{
		Store: fs,
		Config: &config.Config{
			SupabaseURL:            uploadSrv.URL,
			SupabaseServiceRoleKey: "test-key",
		},
		Media:  media.NewRunner(1),
		Logger: testLogger(),
	}

	if err := FromResult(context.Background(), deps, testScene(t), testResult(t, srv.URL)); err != nil {
		t.Fatalf("FromResult() error = %v, want nil", err)
	}

	if len(fs.markDoneCalls) != 1 {
		t.Fatalf("MarkDone called %d times, want 1", len(fs.markDoneCalls))
	}
	if !uploadObservedAtMarkDone {
		t.Fatalf("FromResult reached MarkDone before the upload landed on the fake storage server — upload/MarkDone are out of order")
	}
}

// ---------------------------------------------------------------------------
// Happy path: asserts the actual store.Asset and store.Run FromResult hands
// to MarkDone. These fields feed every spend aggregate in the app (see
// runs.cost_usd in docs/architecture.md § "Schema") and, before fakeStore
// existed, were listed as unverifiable without a live Postgres.
// ---------------------------------------------------------------------------

func TestFromResult_HappyPath_RecordsExpectedAssetAndRun(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("fake clip bytes"))
	}))
	defer srv.Close()
	installFakeFFmpeg(t, 0)

	uploadSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer uploadSrv.Close()

	fs := &fakeStore{}
	deps := Deps{
		Store: fs,
		Config: &config.Config{
			SupabaseURL:            uploadSrv.URL,
			SupabaseServiceRoleKey: "test-key",
		},
		Media:  media.NewRunner(1),
		Logger: testLogger(),
	}

	scene := testScene(t)
	requestID := "fal-request-success-1"
	scene.KieTaskID = &requestID
	if err := FromResult(context.Background(), deps, scene, testResult(t, srv.URL)); err != nil {
		t.Fatalf("FromResult() error = %v, want nil", err)
	}

	if len(fs.markDoneCalls) != 1 {
		t.Fatalf("MarkDone called %d times, want 1", len(fs.markDoneCalls))
	}
	call := fs.markDoneCalls[0]

	if call.sceneID != scene.ID {
		t.Errorf("MarkDone sceneID = %q, want %q", call.sceneID, scene.ID)
	}

	// testScene is not a talking-head scene and carries no render_settings
	// override, so kie.PickModel resolves to the silent default —
	// seedance-2.5, at its own default 480p resolution: 28 credits/s
	// (published, kie.Rates["seedance-2.5"].Silent["480p"]) / 200
	// credits-per-$ = $0.14/s, and testResult's 8-second DurationSeconds
	// sets the billed duration.
	const wantModel = "bytedance/seedance-2-5"
	// 28 credits/s * 8s = 224 credits / 200 credits-per-$. Written as
	// credits-over-CreditsPerUSD, matching EstimateCost's own
	// (rate*duration)/CreditsPerUSD operation order exactly — computing
	// this the other way (28.0/200*8) can differ in the last bit under
	// binary floating point, which would make this comparison flaky rather
	// than a check on FromResult's actual behavior.
	const wantCost = (28.0 * 8) / 200
	const wantDurationS = 8.0
	// Per attempt, not per scene: the key carries the kie task id so a second
	// render of this scene cannot overwrite this one. See
	// store.TestClipKeysAreUniquePerAttempt for what that prevents.
	wantStorageKey := "projects/project-1/clip/scene-1-" + requestID + ".mp4"

	wantAsset := store.Asset{
		ProjectID:  scene.ProjectID,
		Kind:       "clip",
		StorageKey: wantStorageKey,
		DurationS:  ptr(wantDurationS),
		Bytes:      ptr(int64(0)), // fake ffmpeg never writes to outPath, so the pre-created temp file stays empty
	}
	if call.asset.ProjectID != wantAsset.ProjectID ||
		call.asset.Kind != wantAsset.Kind ||
		call.asset.StorageKey != wantAsset.StorageKey ||
		call.asset.DurationS == nil || *call.asset.DurationS != *wantAsset.DurationS ||
		call.asset.Bytes == nil || *call.asset.Bytes != *wantAsset.Bytes {
		t.Errorf("MarkDone asset = %+v (DurationS=%v Bytes=%v), want %+v (DurationS=%v Bytes=%v)",
			call.asset, derefF(call.asset.DurationS), derefI(call.asset.Bytes),
			wantAsset, derefF(wantAsset.DurationS), derefI(wantAsset.Bytes))
	}

	if call.run.Vendor != kie.Vendor {
		t.Errorf("MarkDone run.Vendor = %q, want %q", call.run.Vendor, kie.Vendor)
	}
	if call.run.KieTaskID == nil || *call.run.KieTaskID != requestID {
		t.Errorf("MarkDone run.KieTaskID = %v, want %q", derefString(call.run.KieTaskID), requestID)
	}
	if call.run.Model != wantModel {
		t.Errorf("MarkDone run.Model = %q, want %q", call.run.Model, wantModel)
	}
	if call.run.CostUSD == nil {
		t.Fatalf("MarkDone run.CostUSD = nil, want %v — a nil cost on a billed render is exactly the "+
			"billed-recorded-as-free bug this seam exists to catch", wantCost)
	}
	if *call.run.CostUSD != wantCost {
		t.Errorf("MarkDone run.CostUSD = %v, want %v", *call.run.CostUSD, wantCost)
	}
	if call.run.LatencyMS == nil || *call.run.LatencyMS != 0 {
		// scene.SubmittedAt is nil in testScene, so FromResult never starts
		// the since(SubmittedAt) clock — LatencyMS stays its zero value.
		t.Errorf("MarkDone run.LatencyMS = %v, want pointer to 0", derefI32(call.run.LatencyMS))
	}
	if call.run.InferenceMS == nil || *call.run.InferenceMS != 4200 {
		t.Errorf("MarkDone run.InferenceMS = %v, want pointer to 4200", derefI32(call.run.InferenceMS))
	}
}

// Unprefixed task ids belong to kie and should be recorded with kie as vendor.
func TestFromResult_RecordsKieVendorForUnprefixedTaskID(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("fake clip bytes"))
	}))
	defer srv.Close()
	installFakeFFmpeg(t, 0)

	uploadSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer uploadSrv.Close()

	fs := &fakeStore{}
	deps := Deps{
		Store: fs,
		Config: &config.Config{
			SupabaseURL:            uploadSrv.URL,
			SupabaseServiceRoleKey: "test-key",
		},
		Media:  media.NewRunner(1),
		Logger: testLogger(),
	}

	if err := FromResult(context.Background(), deps, testScene(t), testResult(t, srv.URL)); err != nil {
		t.Fatalf("FromResult() error = %v, want nil", err)
	}

	if len(fs.markDoneCalls) != 1 {
		t.Fatalf("MarkDone called %d times, want 1", len(fs.markDoneCalls))
	}
	if got := fs.markDoneCalls[0].run.Vendor; got != kie.Vendor {
		t.Errorf("MarkDone run.Vendor = %q, want %q", got, kie.Vendor)
	}
}

func TestFromResult_BytePlusVendorAndMissingTokensKeepCostUnknown(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("fake clip bytes"))
	}))
	defer srv.Close()
	installFakeFFmpeg(t, 0)

	uploadSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer uploadSrv.Close()

	fs := &fakeStore{}
	deps := Deps{
		Store: fs,
		Config: &config.Config{
			SupabaseURL:            uploadSrv.URL,
			SupabaseServiceRoleKey: "test-key",
		},
		Media:  media.NewRunner(1),
		Logger: testLogger(),
	}

	scene := testScene(t)
	requestID := kie.BytePlusTaskPrefix + "cgt-123"
	scene.KieTaskID = &requestID
	if err := FromResult(context.Background(), deps, scene, testResult(t, srv.URL)); err != nil {
		t.Fatalf("FromResult() error = %v, want nil", err)
	}
	if len(fs.markDoneCalls) != 1 {
		t.Fatalf("MarkDone called %d times, want 1", len(fs.markDoneCalls))
	}
	run := fs.markDoneCalls[0].run
	if run.Vendor != kie.BytePlusVendor {
		t.Errorf("MarkDone run.Vendor = %q, want %q", run.Vendor, kie.BytePlusVendor)
	}
	if run.CostUSD != nil || run.Error == nil || !strings.HasPrefix(*run.Error, store.BillingUnknownPrefix) {
		t.Errorf("MarkDone run cost/error = %v/%v, want unknown billing", run.CostUSD, derefString(run.Error))
	}
}

func ptr[T any](v T) *T { return &v }

func derefF(p *float64) any {
	if p == nil {
		return nil
	}
	return *p
}

func derefI(p *int64) any {
	if p == nil {
		return nil
	}
	return *p
}

func derefI32(p *int) any {
	if p == nil {
		return nil
	}
	return *p
}

func derefString(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}
