package loop

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"ugc-pipeline/worker/internal/config"
	"ugc-pipeline/worker/internal/kie"
	"ugc-pipeline/worker/internal/store"
)

func strPtr(s string) *string { return &s }

type taggedSubmissionError struct{ vendor string }

func (e taggedSubmissionError) Error() string            { return "submission failed" }
func (e taggedSubmissionError) SubmissionVendor() string { return e.vendor }

func TestFailSceneRecordsVendorFromSubmitError(t *testing.T) {
	fs := &fakeStore{}
	deps := Deps{Store: fs, Config: &config.Config{}, Logger: testLogger()}
	scene := store.Scene{ID: "scene-1", ProjectID: "project-1"}
	cause := taggedSubmissionError{vendor: kie.BytePlusVendor}
	failScene(context.Background(), deps, testLogger(), scene, cause)
	if len(fs.markFailedCalls) != 1 {
		t.Fatalf("MarkFailed called %d times, want 1", len(fs.markFailedCalls))
	}
	if got := fs.markFailedCalls[0].run.Vendor; got != kie.BytePlusVendor {
		t.Errorf("run vendor = %q, want %q", got, kie.BytePlusVendor)
	}
}

// TestPromptForScene pins the AUDIO_ENABLED speech-injection probe: the
// compiled video_prompt must be sent unchanged to a silent render, and get
// exactly one appended dialogue clause on an audio render — never a
// duplicated script_line, and never dialogue leaking into a submission that
// isn't actually going to carry audio.
func TestPromptForScene(t *testing.T) {
	tests := []struct {
		name       string
		scene      store.Scene
		withSpeech bool
		want       string
	}{
		{
			name: "video_prompt present, speech off -> video_prompt unchanged",
			scene: store.Scene{
				VideoPrompt: strPtr("a woman speaks to camera in a sunlit kitchen"),
				ScriptLine:  strPtr("Ever feel like mornings are a race against the clock?"),
			},
			withSpeech: false,
			want:       "a woman speaks to camera in a sunlit kitchen",
		},
		{
			name: "video_prompt present, speech on -> script_line appended as dialogue",
			scene: store.Scene{
				VideoPrompt: strPtr("a woman speaks to camera in a sunlit kitchen"),
				ScriptLine:  strPtr("Ever feel like mornings are a race against the clock?"),
			},
			withSpeech: true,
			want:       `a woman speaks to camera in a sunlit kitchen Dialogue, spoken aloud on camera: "Ever feel like mornings are a race against the clock?"`,
		},
		{
			name: "speech on but no script_line -> video_prompt unchanged, nothing to speak",
			scene: store.Scene{
				VideoPrompt: strPtr("a static product shot on a kitchen counter"),
				ScriptLine:  nil,
			},
			withSpeech: true,
			want:       "a static product shot on a kitchen counter",
		},
		{
			name: "no video_prompt, speech on -> falls back to script_line, not duplicated",
			scene: store.Scene{
				VideoPrompt: nil,
				ScriptLine:  strPtr("Your first order ships free this week."),
			},
			withSpeech: true,
			want:       "Your first order ships free this week.",
		},
		{
			name: "empty video_prompt string treated as absent, falls back to script_line",
			scene: store.Scene{
				VideoPrompt: strPtr(""),
				ScriptLine:  strPtr("One scoop, cold water, done."),
			},
			withSpeech: false,
			want:       "One scoop, cold water, done.",
		},
		{
			name:       "neither field set -> empty string, not a panic",
			scene:      store.Scene{},
			withSpeech: true,
			want:       "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := promptForScene(tt.scene, nil, tt.withSpeech, kie.Model{SupportsRoleReferences: true}); got != tt.want {
				t.Errorf("promptForScene() = %q, want %q", got, tt.want)
			}
		})
	}
}

type recoveryTestKey struct{}

// TestRecoveryCtxSurvivesCancelledParent pins the one property the
// compensating writes in dispatchScene and failScene depend on: a context that
// still works after the dispatch context is dead.
//
// This is deliberately a test of recoveryCtx itself rather than of the call
// sites. Deps.Store is a concrete *store.Store, so observing what MarkFailed
// receives needs a database — that half is covered by the DB-gated store tests.
// What can be pinned here is the decision, and the decision is the part that
// was wrong: writing context.WithTimeout(ctx, ...) instead of
// context.WithoutCancel makes the first subtest below fail, which is the whole
// point of having it.
func TestRecoveryCtxSurvivesCancelledParent(t *testing.T) {
	parent, cancelParent := context.WithCancel(context.WithValue(context.Background(), recoveryTestKey{}, "carried"))
	cancelParent()

	if parent.Err() == nil {
		t.Fatal("test setup: parent context should already be cancelled")
	}

	recCtx, cancel := recoveryCtx(parent)
	defer cancel()

	if err := recCtx.Err(); err != nil {
		t.Errorf("recoveryCtx() inherited the parent's cancellation: %v — a compensating write "+
			"made with it would fail for the same reason the write it is compensating for did", err)
	}

	deadline, ok := recCtx.Deadline()
	if !ok {
		t.Fatal("recoveryCtx() returned a context with no deadline; a wedged write made with it " +
			"could outlive the shutdown budget in cmd/worker/main.go")
	}
	if remaining := time.Until(deadline); remaining > recoveryWriteTimeout {
		t.Errorf("recoveryCtx() deadline is %v away, want at most %v", remaining, recoveryWriteTimeout)
	}

	// Values must survive: dropping cancellation is the point, dropping
	// everything else would silently detach whatever a caller attached.
	if got := recCtx.Value(recoveryTestKey{}); got != "carried" {
		t.Errorf("recoveryCtx().Value() = %v, want %q — context values must still be inherited", got, "carried")
	}
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError + 1}))
}

// TestDispatchScene_LostKieTaskID_RecordsBilledRun pins the exact bug PR
// #6 fixed: kie accepts and starts (and bills) a render, but persisting its
// task id (still stored in the fal-named kie_task_id column — see
// store.Scene.KieTaskID's doc comment) fails on every retry. dispatchScene must not let that scene
// fall through to StaleRendering's nil-KieTaskID branch — which would
// record it as a free "claimed but never submitted" failure — so it marks
// the scene failed itself, right here, with the cost it already knows was
// billed. Before the Store seam existed this was asserted only indirectly
// (recoveryCtx's own decision, in TestRecoveryCtxSurvivesCancelledParent);
// this test is the first to look at the actual store.Run dispatchScene
// hands to MarkFailed.
func TestDispatchScene_LostKieTaskID_RecordsBilledRun(t *testing.T) {
	signSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"signedURL":"/object/sign/media/projects/project-1/ref_frame/scene-1.png?token=test"}`))
	}))
	defer signSrv.Close()

	fs := &fakeStore{
		refFrameURL:      "projects/project-1/ref_frame/scene-1.png",
		markRenderingErr: context.DeadlineExceeded, // every retry fails the same way
	}

	deps := Deps{
		Store: fs,
		Config: &config.Config{
			SupabaseURL:            signSrv.URL,
			SupabaseServiceRoleKey: "test-key",
			AppBaseURL:             "https://worker.example",
			RenderConcurrency:      10,
		},
		Logger: testLogger(),
		// mock=true: Submit returns a deterministic request id with no
		// network call (see kie.Client.Submit's doc comment) — this test is
		// about what happens AFTER kie accepts the job, not about a real
		// submission.
		Kie: kie.NewClient("test-key", true, nil, ""),
	}

	scene := store.Scene{
		ID:            "scene-1",
		ProjectID:     "project-1",
		IsTalkingHead: false,
		DurationS:     8,
		Status:        "rendering",
	}

	dispatchScene(context.Background(), deps, scene, "https://worker.example")

	if fs.markRenderingCalls != 4 {
		t.Fatalf("MarkRendering called %d times, want 4 (markRenderingWithRetry's attempt count)", fs.markRenderingCalls)
	}
	if len(fs.markFailedCalls) != 1 {
		t.Fatalf("MarkFailed called %d times, want 1", len(fs.markFailedCalls))
	}
	call := fs.markFailedCalls[0]

	if call.sceneID != scene.ID {
		t.Errorf("MarkFailed sceneID = %q, want %q", call.sceneID, scene.ID)
	}
	if call.run.Vendor != kie.Vendor {
		t.Errorf("MarkFailed run.Vendor = %q, want %q", call.run.Vendor, kie.Vendor)
	}
	if call.run.KieTaskID == nil || *call.run.KieTaskID == "" {
		t.Fatal("MarkFailed run.KieTaskID is empty; the accepted request would be lost from the per-attempt ledger")
	}
	if call.run.Error == nil || !strings.Contains(*call.run.Error, *call.run.KieTaskID) {
		t.Errorf("MarkFailed run.Error = %v, want it to name persisted kie request %q",
			derefStr(call.run.Error), *call.run.KieTaskID)
	}

	// This is the assertion that matters: a render kie already started and
	// billed must never land in runs with cost_usd nil — that reclassifies
	// a real dollar spent as a free failure the moment reconcile/an operator
	// reads the ledger.
	// seedance-2.5's own default (480p, silent) rate — the model a scene
	// with no render_settings override resolves to. 28 credits/s * 8s = 224
	// credits / 200 credits-per-$; written as credits-over-CreditsPerUSD to
	// match EstimateCost's own operation order exactly (see
	// fromresult_test.go's identical comment for why the other grouping can
	// differ in the last bit).
	const wantCost = (28.0 * 8) / 200
	if call.run.CostUSD == nil {
		t.Fatalf("MarkFailed run.CostUSD = nil, want %v — a billed render must not be recorded as free", wantCost)
	}
	if *call.run.CostUSD != wantCost {
		t.Errorf("MarkFailed run.CostUSD = %v, want %v", *call.run.CostUSD, wantCost)
	}
	if call.run.Error == nil || !strings.Contains(*call.run.Error, "kie accepted request") {
		t.Errorf("MarkFailed run.Error = %v, want it to say kie accepted the request but the id could not be saved",
			derefStr(call.run.Error))
	}
}

func TestDispatchScene_LostBytePlusTaskID_RecordsUnknownBilling(t *testing.T) {
	signSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"signedURL":"/object/sign/media/projects/project-1/ref_frame/scene-1.png?token=test"}`))
	}))
	defer signSrv.Close()

	fs := &fakeStore{
		refFrameURL:      "projects/project-1/ref_frame/scene-1.png",
		markRenderingErr: context.DeadlineExceeded,
	}
	deps := Deps{
		Store: fs,
		Config: &config.Config{
			SupabaseURL:            signSrv.URL,
			SupabaseServiceRoleKey: "test-key",
			AppBaseURL:             "https://worker.example",
			RenderConcurrency:      10,
		},
		Logger: testLogger(),
		Kie:    &fakeVideoVendor{name: kie.BytePlusTaskPrefix + "cgt-123"},
	}

	scene := store.Scene{ID: "scene-1", ProjectID: "project-1", DurationS: 8, Status: "rendering"}
	dispatchScene(context.Background(), deps, scene, "https://worker.example")
	if len(fs.markFailedCalls) != 1 {
		t.Fatalf("MarkFailed called %d times, want 1", len(fs.markFailedCalls))
	}
	run := fs.markFailedCalls[0].run
	if run.Vendor != kie.BytePlusVendor || run.KieTaskID == nil || *run.KieTaskID != kie.BytePlusTaskPrefix+"cgt-123" {
		t.Errorf("MarkFailed run vendor/id = %q/%v, want BytePlus and its task id", run.Vendor, run.KieTaskID)
	}
	if run.CostUSD != nil || run.Error == nil || !strings.HasPrefix(*run.Error, store.BillingUnknownPrefix) {
		t.Errorf("MarkFailed run cost/error = %v/%v, want unknown billing", run.CostUSD, derefStr(run.Error))
	}
}

func derefStr(p *string) string {
	if p == nil {
		return "<nil>"
	}
	return *p
}

// TestDispatchScene_AmbiguousSubmission_RecordsBillingUnknown pins XC1: an
// ambiguous submission (kie.ErrSubmissionOutcomeUnknown — the POST was lost
// or answered with a 5xx, so kie may have accepted and billed the job) must
// not be filed as an ordinary free failure. failScene's premise, "kie never
// started this, so it cannot have billed", is false for exactly this error.
// cost_usd stays nil — an estimate would fabricate a charge kie may never
// have made — and the tag is what makes the unresolved ones queryable.
func TestDispatchScene_AmbiguousSubmission_RecordsBillingUnknown(t *testing.T) {
	signSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"signedURL":"/object/sign/media/projects/project-1/ref_frame/scene-1.png?token=test"}`))
	}))
	defer signSrv.Close()

	fs := &fakeStore{refFrameURL: "projects/project-1/ref_frame/scene-1.png"}

	// A real (non-mock) kie client whose transport always 5xxes: that is the
	// ambiguous outcome X1 refuses to replay, and the submit path is the only
	// way to get the error dispatchScene actually sees.
	var submits int
	kieHTTP := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		// The reference image is copied through kie's upload first; that part
		// succeeds, so the 5xx below really is the createTask POST.
		if resp, ok := prepResponse(req); ok {
			return resp, nil
		}
		submits++
		return &http.Response{
			StatusCode: http.StatusBadGateway,
			Body:       io.NopCloser(strings.NewReader("upstream gone")),
			Header:     make(http.Header),
			Request:    req,
		}, nil
	})}

	deps := Deps{
		Store: fs,
		Config: &config.Config{
			SupabaseURL:            signSrv.URL,
			SupabaseServiceRoleKey: "test-key",
			AppBaseURL:             "https://worker.example",
			RenderConcurrency:      10,
		},
		Logger: testLogger(),
		Kie:    kie.NewClient("test-key", false, kieHTTP, ""),
	}

	scene := store.Scene{
		ID:            "scene-1",
		ProjectID:     "project-1",
		IsTalkingHead: false,
		DurationS:     8,
		Status:        "rendering",
	}

	dispatchScene(context.Background(), deps, scene, "https://worker.example")

	if submits != 1 {
		t.Errorf("kie submitted %d times, want 1 (an ambiguous billable POST must not be replayed)", submits)
	}
	if len(fs.markFailedCalls) != 1 {
		t.Fatalf("MarkFailed called %d times, want 1", len(fs.markFailedCalls))
	}
	run := fs.markFailedCalls[0].run

	if run.CostUSD != nil {
		t.Errorf("MarkFailed run.CostUSD = %v, want nil — an unknown charge must not be recorded as a known one", *run.CostUSD)
	}
	if run.Error == nil || !strings.HasPrefix(*run.Error, store.BillingUnknownPrefix) {
		t.Errorf("MarkFailed run.Error = %q, want it prefixed %q", derefStr(run.Error), store.BillingUnknownPrefix)
	}
}

// A failure while PREPARING the reference images — the download from storage or
// the copy through kie's file upload — happens before anything is submitted, so
// kie cannot have started or billed the job. It must be an ordinary free
// failure: tagging it billing-unknown would send someone to chase a charge that
// does not exist. The createTask POST must never go out.
func TestDispatchScene_ReferencePrepFailure_IsNotBillingUnknown(t *testing.T) {
	signSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"signedURL":"/object/sign/media/projects/project-1/ref_frame/scene-1.png?token=test"}`))
	}))
	defer signSrv.Close()

	fs := &fakeStore{refFrameURL: "projects/project-1/ref_frame/scene-1.png"}

	var createTasks int
	kieHTTP := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.Method == http.MethodGet { // the reference image download fails
			return &http.Response{
				StatusCode: http.StatusBadGateway,
				Body:       io.NopCloser(strings.NewReader("storage down")),
				Header:     make(http.Header),
				Request:    req,
			}, nil
		}
		createTasks++
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(`{"code":200,"data":{"taskId":"task-1"}}`)),
			Header:     make(http.Header),
			Request:    req,
		}, nil
	})}

	deps := Deps{
		Store: fs,
		Config: &config.Config{
			SupabaseURL:            signSrv.URL,
			SupabaseServiceRoleKey: "test-key",
			AppBaseURL:             "https://worker.example",
			RenderConcurrency:      10,
		},
		Logger: testLogger(),
		Kie:    kie.NewClient("test-key", false, kieHTTP, ""),
	}

	scene := store.Scene{
		ID:        "scene-1",
		ProjectID: "project-1",
		DurationS: 8,
		Status:    "rendering",
	}

	dispatchScene(context.Background(), deps, scene, "https://worker.example")

	if createTasks != 0 {
		t.Errorf("createTask went out %d times after the references failed to prepare, want 0", createTasks)
	}
	if len(fs.markFailedCalls) != 1 {
		t.Fatalf("MarkFailed called %d times, want 1", len(fs.markFailedCalls))
	}
	run := fs.markFailedCalls[0].run
	if run.Error != nil && strings.HasPrefix(*run.Error, store.BillingUnknownPrefix) {
		t.Errorf("a failure before submission was tagged %q: %q", store.BillingUnknownPrefix, *run.Error)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }
